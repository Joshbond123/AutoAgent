#!/usr/bin/env python3
"""
AutoAgent Pro — Browser Use Worker v3
AI:      Cerebras llama3.1-8b (primary, proven fast) → qwen-3-235b fallback
Browser: Playwright stealth + human timing
Screenshots: Live JPEG streaming → Supabase public storage → chat UI
CAPTCHA: NopeCHA (reCAPTCHA v2/v3, hCaptcha, Turnstile) + CF JS auto-wait
"""

import asyncio, os, sys, json, re, traceback, random, base64, time
from datetime import datetime
from typing import Optional, List

import httpx

try:
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("[WARN] supabase not installed", flush=True)

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL      = os.environ.get("SUPABASE_URL", "")
SUPABASE_SVC_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
NOPECHA_KEY       = os.environ.get("NOPECHA_API_KEY", "")
CEREBRAS_BASE     = "https://api.cerebras.ai/v1"

# Model priority: llama3.1-8b works with this key; qwen as fallback when rate-limited
CEREBRAS_MODELS   = ["llama3.1-8b", "qwen-3-235b-a22b-instruct-2507"]

SCREENSHOT_BUCKET = "screenshots"
SCREENSHOT_EVERY  = 4   # capture every N steps


# ── Cerebras Key Pool ─────────────────────────────────────────────────────────
class CerebrasPool:
    def __init__(self, keys: List[str]):
        self.keys  = [k.strip() for k in keys if k.strip()]
        self.idx   = 0
        self.failed: set = set()

    def next_key(self) -> Optional[str]:
        avail = [k for k in self.keys if k not in self.failed]
        if not avail:
            self.failed.clear()
            avail = self.keys
        if not avail:
            return None
        key = avail[self.idx % len(avail)]
        self.idx = (self.idx + 1) % len(avail)
        return key

    def mark_failed(self, key: str):
        self.failed.add(key)

    @property
    def size(self):
        return len(self.keys)


async def cerebras_chat(pool: CerebrasPool, messages: list,
                        system: str = "", max_tokens: int = 800) -> str:
    """Call Cerebras with model fallback chain."""
    for model in CEREBRAS_MODELS:
        for attempt in range(3):
            key = pool.next_key()
            if not key:
                raise RuntimeError("No Cerebras keys available")
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            body_msgs = []
            if system:
                body_msgs.append({"role": "system", "content": system})
            body_msgs.extend(messages)
            try:
                async with httpx.AsyncClient(timeout=45) as c:
                    r = await c.post(f"{CEREBRAS_BASE}/chat/completions", headers=headers, json={
                        "model": model,
                        "messages": body_msgs,
                        "temperature": 0.15,
                        "max_tokens": max_tokens,
                    })
                if r.status_code in (401, 403):
                    pool.mark_failed(key)
                    break
                if r.status_code == 404:
                    print(f"[Cerebras] {model} not available, trying next model…", flush=True)
                    break  # try next model
                if r.status_code == 429:
                    wait = (attempt + 1) * 3
                    print(f"[Cerebras] Rate limited on {model}, waiting {wait}s…", flush=True)
                    await asyncio.sleep(wait)
                    continue
                r.raise_for_status()
                reply = r.json()["choices"][0]["message"]["content"]
                print(f"[Cerebras] {model} → {len(reply)} chars (key …{key[-6:]})", flush=True)
                return reply
            except Exception as e:
                err = str(e)
                if "404" in err or "not_found" in err.lower():
                    break
                print(f"[Cerebras] {model} attempt {attempt+1}: {e}", flush=True)
                if attempt == 2:
                    break
    raise RuntimeError("Cerebras: all models exhausted")


# ── Supabase Logging ──────────────────────────────────────────────────────────
def log(task_id: str, message: str, log_type: str = "info", supabase=None, metadata: dict = None):
    prefix = {"info": "ℹ", "success": "✓", "error": "✗", "warning": "⚠"}.get(log_type, "ℹ")
    print(f"{prefix} {message}", flush=True)
    if supabase and task_id:
        try:
            row = {
                "task_id":    task_id,
                "message":    message,
                "log_type":   log_type,
                "created_at": datetime.utcnow().isoformat(),
            }
            if metadata:
                row["metadata"] = metadata
            supabase.table("task_logs").insert(row).execute()
        except Exception as e:
            print(f"[WARN] log persist: {e}", flush=True)


# ── Screenshot Upload ─────────────────────────────────────────────────────────
async def upload_screenshot(page, task_id: str, step: int, label: str,
                             supabase=None) -> Optional[str]:
    """Capture page screenshot, upload to Supabase Storage, return public URL."""
    try:
        screenshot_bytes = await page.screenshot(type="jpeg", quality=65,
                                                  full_page=False, timeout=8000)
        path = f"task_{task_id[:8]}/step_{step:03d}_{int(time.time())}.jpg"

        if supabase:
            supabase.storage.from_(SCREENSHOT_BUCKET).upload(
                path, screenshot_bytes,
                file_options={"content-type": "image/jpeg", "upsert": "true"}
            )
            public_url = (
                f"{SUPABASE_URL}/storage/v1/object/public/{SCREENSHOT_BUCKET}/{path}"
            )
            log(task_id, f"SCREENSHOT: {public_url}", "info", supabase,
                metadata={"step": step, "label": label})
            return public_url
        else:
            # Fallback: embed base64 directly (visible in chat UI too)
            b64 = base64.b64encode(screenshot_bytes).decode()
            data_url = f"data:image/jpeg;base64,{b64}"
            log(task_id, data_url, "info", supabase)
            return data_url
    except Exception as e:
        print(f"[Screenshot] Error at step {step}: {e}", flush=True)
        return None


# ── CAPTCHA Handler ───────────────────────────────────────────────────────────
async def handle_captcha(page, task_id: str, supabase=None, nopecha_key: str = "") -> bool:
    """Detect and solve CAPTCHA on current page."""
    try:
        content = await page.content()
        url = page.url

        # Cloudflare JS challenge — just wait
        if "Just a moment" in content or "Checking your browser" in content or \
           ("cf-browser-verification" in content and "cloudflare" in content.lower()):
            log(task_id, "🛡️ Cloudflare JS challenge detected — waiting 15s for auto-resolve…",
                "warning", supabase)
            await asyncio.sleep(15)
            new_content = await page.content()
            if "Just a moment" not in new_content and "Checking your browser" not in new_content:
                log(task_id, "✅ Cloudflare JS challenge passed!", "success", supabase)
                return True
            log(task_id, "⚠️ Cloudflare still blocking — continuing anyway", "warning", supabase)
            return True

        if not nopecha_key:
            # Still detect and report — just can't solve
            if "g-recaptcha" in content or "hcaptcha" in content.lower() or "turnstile" in content.lower():
                sitekey_m = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
                captcha_type = "reCAPTCHA v2"
                if "hcaptcha" in content.lower(): captcha_type = "hCaptcha"
                elif "turnstile" in content.lower(): captcha_type = "Turnstile"
                sk = sitekey_m.group(1)[:20] if sitekey_m else "unknown"
                log(task_id, f"🔐 {captcha_type} detected (sitekey: {sk}…) — NopeCHA key not configured",
                    "warning", supabase)
            return False

        sitekey_match = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if not sitekey_match:
            return False

        sitekey = sitekey_match.group(1)
        if "hcaptcha" in content.lower():
            captcha_type = "hcaptcha"
        elif "turnstile" in content.lower():
            captcha_type = "turnstile"
        elif "recaptcha/api2" in content or "recaptcha/enterprise" in content:
            captcha_type = "recaptchav2"
        else:
            captcha_type = "recaptchav2"

        log(task_id, f"🔐 {captcha_type.upper()} detected — solving via NopeCHA…", "info", supabase)

        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post("https://api.nopecha.com/", json={
                "type":    captcha_type,
                "sitekey": sitekey,
                "url":     url,
                "key":     nopecha_key,
            })
            data = res.json()
            if data.get("error"):
                log(task_id, f"CAPTCHA submit error: {data['error']}", "warning", supabase)
                return False

            captcha_id = data.get("id")
            log(task_id, f"CAPTCHA task submitted (id: {captcha_id}) — polling…", "info", supabase)

            for poll_n in range(80):
                await asyncio.sleep(3)
                p = await client.get("https://api.nopecha.com/",
                                     params={"key": nopecha_key, "id": captcha_id})
                pd = p.json()
                if not pd.get("error") and pd.get("data"):
                    token = pd["data"][0] if isinstance(pd["data"], list) else pd["data"]
                    # Inject token
                    if captcha_type == "hcaptcha":
                        await page.evaluate(f"""
                            (() => {{
                              const r = document.querySelector('[name="h-captcha-response"]');
                              if(r) r.value = '{token}';
                              if(window.hcaptcha) window.hcaptcha.execute = ()=>Promise.resolve('{token}');
                            }})()
                        """)
                    elif captcha_type == "turnstile":
                        await page.evaluate(f"""
                            (() => {{
                              const r = document.querySelector('[name="cf-turnstile-response"]');
                              if(r) r.value = '{token}';
                            }})()
                        """)
                    else:
                        await page.evaluate(f"""
                            (() => {{
                              const r = document.getElementById('g-recaptcha-response');
                              if(r) r.innerHTML = '{token}';
                              if(typeof ___grecaptcha_cfg !== 'undefined') {{
                                Object.values(___grecaptcha_cfg.clients||{{}}).forEach(c => {{
                                  try {{ const cb = c?.DDD?.callback || c?.l?.callback;
                                         if(typeof cb === 'function') cb('{token}'); }} catch(e) {{}}
                                }});
                              }}
                            }})()
                        """)
                    log(task_id, f"✅ CAPTCHA solved and token injected! (attempt {poll_n+1})",
                        "success", supabase)
                    return True

        log(task_id, "⏰ CAPTCHA solve timeout (4 minutes)", "warning", supabase)
        return False

    except Exception as e:
        log(task_id, f"CAPTCHA handler error: {e}", "warning", supabase)
        return False


# ── Page Context Gatherer ─────────────────────────────────────────────────────
async def get_page_context(page, prompt: str, memory: List[str],
                           completed_extracts: List[str] = None,
                           last_extract_url: str = "") -> str:
    """Build rich page context for Cerebras decision making."""
    if completed_extracts is None:
        completed_extracts = []
    try:
        ctx = await page.evaluate("""() => {
            const getText = (el) => el ? (el.innerText || el.textContent || '').trim() : '';
            const bodyText = getText(document.body).slice(0, 2500);
            const inputs = Array.from(document.querySelectorAll(
                'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select'
            )).slice(0,12).map(e => ({
                tag: e.tagName, type: e.type||'', name: e.name||'', id: e.id||'',
                placeholder: e.placeholder||'', value: (e.value||'').slice(0,30),
                'aria-label': e.getAttribute('aria-label')||''
            }));
            const buttons = Array.from(document.querySelectorAll(
                'button,input[type=submit],input[type=button],[role=button]'
            )).slice(0,12).map(e => ({
                tag: e.tagName, id: e.id||'', class: (e.className||'').slice(0,40),
                text: getText(e).slice(0,60)
            }));
            const links = Array.from(document.querySelectorAll('a[href]'))
                .slice(0,10).map(a => ({ text: getText(a).slice(0,50), href: a.href }));
            const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
                .slice(0,5).map(h => getText(h));
            const errors = Array.from(document.querySelectorAll(
                '[class*=error],[class*=alert],[role=alert],[class*=warning]'
            )).slice(0,3).map(e => getText(e).slice(0,100));
            return { url: location.href, title: document.title,
                     bodyText, inputs, buttons, links, headings, errors };
        }""")
    except Exception:
        ctx = {"url": page.url, "title": "Unknown", "bodyText": "",
               "inputs": [], "buttons": [], "links": [], "headings": [], "errors": []}

    mem_str = ""
    if memory:
        mem_str = "\nEXTRACTED SO FAR:\n" + "\n".join(f"  • {m[:200]}" for m in memory[-6:])

    completed_str = ""
    if completed_extracts:
        completed_str = f"\nCOMPLETED STEPS: {', '.join(completed_extracts)} — these are DONE, do NOT re-extract them. Move to the NEXT step."

    next_hint = ""
    if completed_extracts and last_extract_url == ctx.get('url', ''):
        next_hint = "\n⚡ IMPORTANT: You already collected data on this page. Your next action MUST be GOTO (navigate to the next URL in the task) or FINISH if all data is collected."

    return f"""URL: {ctx['url']}
TITLE: {ctx['title']}
HEADINGS: {' | '.join(ctx.get('headings', [])[:3])}
PAGE TEXT (first 1500 chars):
{ctx.get('bodyText', '')[:1500]}
INPUTS: {json.dumps(ctx.get('inputs', [])[:6])}
LINKS: {json.dumps(ctx.get('links', [])[:6])}
TASK: {prompt}{completed_str}{mem_str}{next_hint}"""


# ── Bulletproof JSON Extractor ────────────────────────────────────────────────
def extract_action_json(raw: str) -> Optional[dict]:
    """
    Extract a valid action JSON object from Cerebras output.
    Handles: markdown code blocks, single quotes, trailing commas,
             Python-style True/False/None, extra whitespace.
    """
    text = raw.strip()

    # 1. Strip markdown code fences
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE)
    text = text.strip()

    # 2. Try to find JSON object boundaries
    patterns = [
        r'\{[^{}]*"action"\s*:[^{}]*\}',       # strict: action key inside {}
        r'\{[^{}]*\}',                            # any {} block
        r'\{.*?\}',                               # fallback: first {}
    ]
    candidates = []
    for pat in patterns:
        m = re.search(pat, text, re.DOTALL)
        if m:
            candidates.append(m.group())

    # Also try the whole text if it looks like JSON
    if text.startswith('{') and text.endswith('}'):
        candidates.insert(0, text)

    for raw_json in candidates:
        # Fix common issues
        fixed = raw_json
        # Remove trailing commas before } or ]
        fixed = re.sub(r',\s*([}\]])', r'\1', fixed)
        # Replace single-quote strings with double quotes (simple cases)
        fixed = re.sub(r"'([^']*)'", r'"\1"', fixed)
        # Fix Python booleans/None
        fixed = fixed.replace('True', 'true').replace('False', 'false').replace('None', 'null')
        # Remove JS-style comments
        fixed = re.sub(r'//[^\n]*', '', fixed)

        try:
            obj = json.loads(fixed)
            if isinstance(obj, dict) and 'action' in obj:
                return obj
        except Exception:
            pass

    # Last resort: look for action keyword and build minimal JSON
    action_m = re.search(r'"action"\s*:\s*"(\w+)"', text)
    if action_m:
        reason_m = re.search(r'"reason"\s*:\s*"([^"]*)"', text)
        return {
            "action": action_m.group(1).upper(),
            "reason": reason_m.group(1) if reason_m else "AI decision (JSON repaired)",
        }

    return None


# ── Main Playwright Agent ─────────────────────────────────────────────────────
async def run_agent(task_id: str, prompt: str, pool: Optional[CerebrasPool],
                    supabase=None) -> dict:
    from playwright.async_api import async_playwright

    log(task_id, "🚀 AutoAgent Pro — Playwright stealth browser starting…", "info", supabase)
    log(task_id, f"📋 Task: {prompt[:120]}…" if len(prompt)>120 else f"📋 Task: {prompt}", "info", supabase)
    if pool:
        log(task_id, f"🧠 Cerebras AI ready — {pool.size} key(s), models: {', '.join(CEREBRAS_MODELS)}",
            "info", supabase)

    memory: List[str] = []   # extracted data memory across steps
    steps_done = 0
    max_steps  = 30
    final_summary = ""

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--window-size=1366,768",
                "--disable-extensions",
                "--disable-default-apps",
            ]
        )
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="America/New_York",
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        # Anti-detection
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
            window.chrome = { runtime: {} };
        """)

        page = await context.new_page()

        # Navigate to first URL in prompt
        url_match = re.search(r'https?://[^\s\'"]+', prompt)
        start_url = url_match.group() if url_match else "https://www.google.com"
        log(task_id, f"🌐 Navigating to {start_url}", "info", supabase)
        try:
            await page.goto(start_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(random.uniform(1.2, 2.5))
        except Exception as e:
            log(task_id, f"Initial navigation error: {e}", "warning", supabase)

        # Check for CAPTCHA on first load
        captcha_result = await handle_captcha(page, task_id, supabase, NOPECHA_KEY)
        if captcha_result:
            await asyncio.sleep(2)

        # Take opening screenshot
        await upload_screenshot(page, task_id, 0, "Initial page load", supabase)

        # ── Agent Loop ───────────────────────────────────────────────────────
        recent_actions: List[str] = []   # loop detection buffer
        consecutive_waits = 0
        completed_extracts: List[str] = []  # labels successfully extracted
        last_extract_url: str = ""          # URL where last extract happened
        extracted_urls: List[str] = []      # URLs where data was successfully extracted

        while steps_done < max_steps:
            steps_done += 1
            current_url = page.url
            log(task_id, f"⚙️ Step {steps_done}/{max_steps} — {current_url[:70]}", "info", supabase)

            # Screenshot every N steps
            if steps_done % SCREENSHOT_EVERY == 0:
                await upload_screenshot(page, task_id, steps_done, f"Step {steps_done}", supabase)

            # Check CAPTCHA each step
            await handle_captcha(page, task_id, supabase, NOPECHA_KEY)

            # ── Loop Detection ────────────────────────────────────────────────
            # If last 4 actions were identical, force a FINISH with what we have
            if len(recent_actions) >= 4 and len(set(recent_actions[-4:])) == 1:
                loop_summary = f"Loop detected — agent repeated same action 4x. Memory: {' | '.join(memory)}"
                log(task_id, f"⚠️ Loop detected — forcing completion", "warning", supabase)
                final_summary = loop_summary
                await upload_screenshot(page, task_id, steps_done, "Loop detected - stopping", supabase)
                break

            # If consecutive WAITs > 5, something is wrong — break
            if consecutive_waits >= 5:
                log(task_id, "⚠️ Too many WAITs — forcing completion with collected data", "warning", supabase)
                final_summary = f"Partial completion after {steps_done} steps. Memory: {' | '.join(memory)}"
                break

            # Build page context
            page_ctx = await get_page_context(page, prompt, memory,
                                              completed_extracts, last_extract_url)

            # Ask Cerebras for next action
            action: Optional[dict] = None
            if pool:
                try:
                    # Build loop-awareness hint
                    loop_hint = ""
                    if consecutive_waits >= 2:
                        loop_hint = f"\n⚠️ IMPORTANT: Last {consecutive_waits} responses had JSON errors. You MUST output ONLY a raw JSON object starting with {{ and ending with }}. No text before or after."
                    if len(recent_actions) >= 3 and len(set(recent_actions[-3:])) == 1:
                        loop_hint += f"\n⚠️ IMPORTANT: You have repeated the same action {len(recent_actions[-3:])}x in a row. Try a DIFFERENT action type."

                    system_prompt = f"""You are AutoAgent Pro, an autonomous web browsing AI.
Output ONLY a single JSON object. No markdown. No explanation. Just the JSON.

ACTIONS (pick ONE — include ALL required fields):
{{"action":"GOTO","url":"https://example.com","reason":"why"}}          <- url is REQUIRED
{{"action":"CLICK","selector":"a.link","reason":"why"}}                  <- selector is REQUIRED
{{"action":"TYPE","selector":"#search","text":"query","reason":"why"}}   <- selector+text REQUIRED
{{"action":"PRESS_KEY","key":"Enter","reason":"why"}}
{{"action":"SCROLL","scrollY":500,"reason":"why"}}
{{"action":"EXTRACT","js":"document.body.innerText","label":"name","reason":"why"}} <- js+label REQUIRED
{{"action":"WAIT","ms":2000,"reason":"why"}}
{{"action":"FINISH","summary":"full summary of all data collected","reason":"done"}}

CRITICAL RULES:
- Output ONLY valid JSON starting with {{ ending with }}
- Use DOUBLE QUOTES for all strings — never single quotes
- GOTO MUST include the full "url" field — e.g. "url":"https://httpbin.org/ip"
- EXTRACT MUST include "js" field (JavaScript expression) and "label" field
- After extracting data from a page, GOTO the next URL immediately — do NOT re-extract
- Use FINISH when ALL required data is collected{loop_hint}"""

                    response = await cerebras_chat(
                        pool,
                        [{"role": "user", "content": page_ctx}],
                        system=system_prompt,
                        max_tokens=400,
                    )

                    # ── Bulletproof JSON extraction ────────────────────────
                    action = extract_action_json(response)

                except Exception as e:
                    log(task_id, f"⚠️ AI error: {str(e)[:100]}", "warning", supabase)

            if not action:
                action = {"action": "WAIT", "ms": 2000, "reason": "awaiting AI response"}

            action_type = action.get("action", "WAIT").upper()
            reason      = action.get("reason", "")
            log(task_id, f"🤖 {action_type}: {reason[:120]}", "info", supabase)

            # Track for loop detection
            action_key = action_type + ":" + str(action.get("url", action.get("selector", "")))[:50]
            recent_actions.append(action_key)
            if len(recent_actions) > 8:
                recent_actions.pop(0)
            consecutive_waits = consecutive_waits + 1 if action_type == "WAIT" else 0

            # ── Execute Action ────────────────────────────────────────────────
            if action_type == "FINISH":
                summary = action.get("summary", reason)
                final_summary = summary
                log(task_id, f"✅ Task complete!\n{summary[:600]}", "success", supabase)
                # Final screenshot
                await upload_screenshot(page, task_id, steps_done, "Task completed", supabase)
                break

            elif action_type == "GOTO":
                target_url = action.get("url", "")
                # Fallback: if model forgot the url field, extract next unextracted URL from prompt
                if not target_url:
                    all_urls = re.findall(r'https?://[^\s\'"<>)]+', prompt)
                    current = page.url.rstrip('/')
                    # Priority 1: URLs not yet extracted at all
                    unextracted = [u for u in all_urls
                                   if u.rstrip('/') not in extracted_urls
                                   and u.rstrip('/') != current]
                    # Priority 2: any URL different from current
                    different = [u for u in all_urls if u.rstrip('/') != current]
                    chosen = (unextracted or different or [None])[0]
                    if chosen:
                        target_url = chosen
                        log(task_id, f"⚠️ GOTO missing url — auto-selected: {target_url[:60]}", "warning", supabase)
                if target_url:
                    try:
                        log(task_id, f"🌐 Navigating to {target_url[:80]}", "info", supabase)
                        await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
                        await asyncio.sleep(random.uniform(0.9, 2.1))
                        await handle_captcha(page, task_id, supabase, NOPECHA_KEY)
                        await upload_screenshot(page, task_id, steps_done, f"Navigated to {target_url[:40]}", supabase)
                        # Reset action tracker so loop detector doesn't fire on valid navigation
                        recent_actions.clear()
                    except Exception as e:
                        log(task_id, f"Navigation error: {str(e)[:100]}", "warning", supabase)
                else:
                    log(task_id, "⚠️ GOTO action has no url and no URLs found in prompt", "warning", supabase)

            elif action_type == "CLICK":
                selector = action.get("selector", "")
                if selector:
                    try:
                        el = await page.wait_for_selector(selector, timeout=10000, state="visible")
                        if el:
                            # Human-like: move mouse first
                            bbox = await el.bounding_box()
                            if bbox:
                                await page.mouse.move(
                                    bbox["x"] + bbox["width"]/2 + random.uniform(-3, 3),
                                    bbox["y"] + bbox["height"]/2 + random.uniform(-3, 3)
                                )
                                await asyncio.sleep(random.uniform(0.05, 0.18))
                            await el.click()
                            await asyncio.sleep(random.uniform(0.4, 1.0))
                    except Exception as e:
                        log(task_id, f"Click error ({selector[:40]}): {str(e)[:80]}", "warning", supabase)
                        # Try JS click as fallback
                        try:
                            await page.evaluate(f'document.querySelector("{selector}")?.click()')
                        except Exception:
                            pass

            elif action_type == "TYPE":
                selector = action.get("selector", "")
                text     = action.get("text", "")
                if selector and text:
                    try:
                        el = await page.wait_for_selector(selector, timeout=8000, state="visible")
                        if el:
                            await el.click()
                            await asyncio.sleep(0.15)
                            await el.triple_click()
                            await asyncio.sleep(0.1)
                            # Human-like typing with natural speed variation
                            for char in text:
                                await page.keyboard.type(char, delay=random.randint(50, 150))
                                if random.random() < 0.05:  # occasional pause
                                    await asyncio.sleep(random.uniform(0.2, 0.5))
                            log(task_id, f'⌨️ Typed "{text[:40]}" into {selector[:40]}', "info", supabase)
                    except Exception as e:
                        log(task_id, f"Type error: {str(e)[:80]}", "warning", supabase)

            elif action_type == "PRESS_KEY":
                key = action.get("key", "Enter")
                await asyncio.sleep(random.uniform(0.1, 0.3))
                await page.keyboard.press(key)
                await asyncio.sleep(random.uniform(0.5, 1.5))
                log(task_id, f"⌨️ Pressed {key}", "info", supabase)

            elif action_type == "SCROLL":
                scroll_y = action.get("scrollY", 400)
                scroll_x = action.get("scrollX", 0)
                # Human-like scroll in chunks
                chunks = max(1, abs(scroll_y) // 120)
                chunk_size = scroll_y / chunks
                for _ in range(chunks):
                    await page.mouse.wheel(scroll_x, chunk_size)
                    await asyncio.sleep(random.uniform(0.06, 0.14))
                await asyncio.sleep(random.uniform(0.3, 0.7))

            elif action_type == "EXTRACT":
                js_expr = action.get("js", "")
                label   = action.get("label", "data")
                if not js_expr:
                    # Model forgot to include js field — use a sensible default
                    js_expr = "document.body.innerText.slice(0, 1000)"
                    label   = "page-content"
                    log(task_id, "⚠️ EXTRACT missing js field — using page text fallback", "warning", supabase)
                try:
                    extracted = await page.evaluate(js_expr)
                    if extracted is None:
                        # Try page text fallback
                        extracted = await page.evaluate("document.body.innerText.slice(0,500)")
                    extracted_str = str(extracted)[:600] if extracted else "(empty — page may need more time to load)"
                    memory.append(f"{label}: {extracted_str}")
                    log(task_id, f"📊 Extracted [{label}]: {extracted_str[:250]}", "success", supabase)
                    # Track completion so model knows to advance
                    if label not in completed_extracts:
                        completed_extracts.append(label)
                    last_extract_url = page.url
                    cur = page.url.rstrip('/')
                    if cur not in extracted_urls:
                        extracted_urls.append(cur)
                    # Reset consecutive waits on successful extract
                    consecutive_waits = 0
                    # Reset recent_actions so loop detector doesn't fire prematurely
                    recent_actions.clear()
                except Exception as e:
                    log(task_id, f"Extract error ({js_expr[:60]}): {str(e)[:80]}", "warning", supabase)
                    # Fallback: get visible text
                    try:
                        fallback = await page.evaluate("document.body.innerText.slice(0,300)")
                        memory.append(f"{label}-fallback: {fallback}")
                        log(task_id, f"📊 Extracted [{label}-fallback via body text]: {str(fallback)[:150]}", "success", supabase)
                    except Exception:
                        pass

            elif action_type == "WAIT":
                ms = min(action.get("ms", 2000), 8000)
                await asyncio.sleep(ms / 1000)

            # Natural inter-step delay
            await asyncio.sleep(random.uniform(0.4, 1.1))

        # ── Wrap up ───────────────────────────────────────────────────────────
        if not final_summary:
            final_summary = f"Completed {steps_done} steps. Memory: {' | '.join(memory[-3:])}"
            log(task_id, f"🏁 Agent finished {steps_done} steps", "success", supabase)
            await upload_screenshot(page, task_id, steps_done, "Final state", supabase)

        # Compile result
        result_summary = final_summary
        if memory:
            result_summary += "\n\nEXTRACTED DATA:\n" + "\n".join(f"• {m}" for m in memory)

        await browser.close()
        return {
            "success": True,
            "summary": result_summary[:2000],
            "steps":   steps_done,
            "memory":  memory,
        }


# ── Task Runner ───────────────────────────────────────────────────────────────
async def run_task(task_id: str):
    supabase = None
    if SUPABASE_AVAILABLE and SUPABASE_URL and SUPABASE_SVC_KEY:
        supabase = create_client(SUPABASE_URL, SUPABASE_SVC_KEY)

    # Fetch task
    task = None
    if supabase:
        try:
            res = supabase.table("tasks").select("*").eq("id", task_id).single().execute()
            task = res.data
        except Exception as e:
            print(f"[ERROR] Fetch task: {e}", flush=True)

    if not task:
        print(f"[ERROR] Task {task_id} not found", flush=True)
        return

    prompt = task.get("prompt", "")
    name   = task.get("name", "Unknown")
    user_id = task.get("user_id", "")

    # Load Cerebras keys (settings table + env)
    pool = None
    all_keys = []
    if supabase and user_id:
        try:
            sr = supabase.table("settings").select("cerebras_keys").eq("user_id", user_id).execute()
            for row in (sr.data or []):
                all_keys.extend(row.get("cerebras_keys") or [])
        except Exception as e:
            print(f"[WARN] Settings load: {e}", flush=True)

    env_keys = [k.strip() for k in os.environ.get("CEREBRAS_API_KEYS", "").split(",") if k.strip()]
    all_keys.extend(env_keys)
    all_keys = list(dict.fromkeys(all_keys))  # deduplicate

    if all_keys:
        pool = CerebrasPool(all_keys)
        print(f"[Cerebras] Pool ready: {pool.size} key(s)", flush=True)

    # Mark running
    if supabase:
        supabase.table("tasks").update({
            "status":   "running",
            "last_run": datetime.utcnow().isoformat(),
            "error":    None,
        }).eq("id", task_id).execute()

    log(task_id, f"🤖 AutoAgent Pro starting — Task: {name}", "info", supabase)

    # Run
    result = {"success": False, "summary": "", "steps": 0}
    try:
        result = await run_agent(task_id, prompt, pool, supabase)
    except Exception as e:
        log(task_id, f"❌ Agent crashed: {e}", "error", supabase)
        traceback.print_exc()
        result = {"success": False, "summary": str(e)[:500], "steps": 0}

    # Save result
    if supabase:
        supabase.table("tasks").update({
            "status": "completed" if result["success"] else "failed",
            "result": {
                "success":     result["success"],
                "summary":     result.get("summary", "")[:2000],
                "stepCount":   result.get("steps", 0),
                "completedAt": datetime.utcnow().isoformat(),
            },
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", task_id).execute()

    status = "✅ SUCCESS" if result["success"] else "❌ FAILED"
    log(task_id, f"{status} — {result.get('steps', 0)} steps | {result.get('summary','')[:150]}",
        "success" if result["success"] else "error", supabase)


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TASK_ID", "")
    if not tid:
        print("Usage: python browser_use_worker.py <task_id>", flush=True)
        sys.exit(1)
    asyncio.run(run_task(tid))
