#!/usr/bin/env python3
"""
AutoAgent Pro — Browser Agent Worker v4
Primary AI:  Cerebras gpt-oss-120b (text reasoning)
Vision AI:   Cloudflare Workers AI kimi-k2.6 (screenshot analysis)
Browser:     Playwright stealth + human timing
CAPTCHA:     NopeCHA (reCAPTCHA v2/v3, hCaptcha, CF Turnstile)
Screenshots: Base64 JPEG → task_logs (log_type="screenshot") → realtime UI
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

# ── Config ─────────────────────────────────────────────────────────────────────
SUPABASE_URL      = os.environ.get("SUPABASE_URL", "")
SUPABASE_SVC_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
NOPECHA_KEY       = os.environ.get("NOPECHA_API_KEY", "")
CEREBRAS_BASE     = "https://api.cerebras.ai/v1"
CEREBRAS_MODELS   = ["llama3.1-8b", "qwen-3-235b-a22b-instruct-2507", "gpt-oss-120b"]

# Cloudflare env (overridden by user settings from DB)
CF_ACCOUNT_ID_ENV = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CF_API_KEY_ENV    = os.environ.get("CLOUDFLARE_API_KEY", "")
CF_MODEL_ENV      = os.environ.get("CLOUDFLARE_MODEL", "@cf/moonshotai/kimi-k2.6")

SCREENSHOT_EVERY  = 3   # capture every N steps


# ── Cerebras Key Pool ──────────────────────────────────────────────────────────
class CerebrasPool:
    def __init__(self, keys: List[str]):
        self.keys   = [k.strip() for k in keys if k.strip()]
        self.idx    = 0
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
    def size(self): return len(self.keys)


# ── Cloudflare AI Pool ─────────────────────────────────────────────────────────
import json as _json

class CFCredential:
    """A single Cloudflare account credential."""
    def __init__(self, account_id: str, api_key: str, model: str, label: str = ""):
        self.account_id = account_id.strip()
        self.api_key    = api_key.strip()
        self.model      = (model or "@cf/moonshotai/kimi-k2.6").strip()
        self.label      = label or "Account"

    def __repr__(self):
        return f"CFCredential({self.label}, acct={self.account_id[:12]}…)"


class CloudflarePool:
    """
    Multi-account Cloudflare pool.
    Accepts credential list parsed from the new JSON format in cloudflare_keys[],
    or falls back to the legacy single-account format.
    """
    def __init__(self, credentials: List["CFCredential"], default_model: str = ""):
        self.credentials = [c for c in credentials if c.account_id and c.api_key]
        self.default_model = default_model or "@cf/moonshotai/kimi-k2.6"
        self.idx    = 0
        self.failed: set = set()  # set of (account_id, api_key) tuples

    def next_credential(self) -> Optional["CFCredential"]:
        avail = [c for c in self.credentials if (c.account_id, c.api_key) not in self.failed]
        if not avail:
            self.failed.clear()
            avail = self.credentials
        if not avail:
            return None
        cred = avail[self.idx % len(avail)]
        self.idx = (self.idx + 1) % len(avail)
        return cred

    def mark_failed(self, cred: "CFCredential"):
        self.failed.add((cred.account_id, cred.api_key))
        print(f"[Cloudflare] Credential failed: {cred.label} — rotating to next", flush=True)

    @property
    def ready(self): return len(self.credentials) > 0
    @property
    def size(self): return len(self.credentials)

    # Legacy compat: next_key() → returns api_key of next credential
    def next_key(self) -> Optional[str]:
        c = self.next_credential()
        return c.api_key if c else None

    # Legacy compat: account_id → first credential
    @property
    def account_id(self) -> str:
        return self.credentials[0].account_id if self.credentials else ""

    @property
    def model(self) -> str:
        return self.credentials[0].model if self.credentials else self.default_model


def parse_cf_credentials(raw_keys: List[str], fallback_account_id: str = "",
                          fallback_model: str = "") -> List[CFCredential]:
    """Parse cloudflare_keys[] which may contain JSON credential objects or plain API keys."""
    creds = []
    for item in (raw_keys or []):
        item = item.strip()
        if not item:
            continue
        try:
            obj = _json.loads(item)
            if isinstance(obj, dict) and obj.get("api_key"):
                if not obj.get("enabled", True):
                    continue  # skip disabled credentials
                creds.append(CFCredential(
                    account_id = obj.get("account_id", fallback_account_id),
                    api_key    = obj["api_key"],
                    model      = obj.get("model", fallback_model) or fallback_model,
                    label      = obj.get("label", "Account"),
                ))
                continue
        except Exception:
            pass
        # Legacy: plain API key string — use fallback account_id
        if fallback_account_id:
            creds.append(CFCredential(
                account_id = fallback_account_id,
                api_key    = item,
                model      = fallback_model or "@cf/moonshotai/kimi-k2.6",
                label      = "Legacy Key",
            ))
    return creds


async def cerebras_chat(pool: CerebrasPool, messages: list,
                        system: str = "", max_tokens: int = 500) -> str:
    """Call Cerebras with model fallback chain and key rotation."""
    for model in CEREBRAS_MODELS:
        for attempt in range(3):
            key = pool.next_key()
            if not key:
                raise RuntimeError("No Cerebras keys available")
            hdrs = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            msgs = ([{"role": "system", "content": system}] if system else []) + messages
            try:
                async with httpx.AsyncClient(timeout=45) as c:
                    r = await c.post(f"{CEREBRAS_BASE}/chat/completions", headers=hdrs, json={
                        "model": model, "messages": msgs, "temperature": 0.15, "max_tokens": max_tokens,
                    })
                if r.status_code in (401, 403):
                    pool.mark_failed(key); break
                if r.status_code == 404:
                    break  # try next model
                if r.status_code == 429:
                    await asyncio.sleep((attempt + 1) * 3); continue
                r.raise_for_status()
                reply = r.json()["choices"][0]["message"]["content"]
                print(f"[Cerebras] {model} → {len(reply)} chars (…{key[-6:]})", flush=True)
                return reply
            except Exception as e:
                if "404" in str(e) or "not_found" in str(e).lower():
                    break
                print(f"[Cerebras] {model} attempt {attempt+1}: {e}", flush=True)
                if attempt == 2: break
    raise RuntimeError("Cerebras: all models exhausted")


async def cloudflare_vision(cf: CloudflarePool, screenshot_b64: str, prompt_text: str) -> Optional[str]:
    """Send screenshot + prompt to Cloudflare vision model. Rotates on failure."""
    if not cf.ready:
        return None
    cred = cf.next_credential()
    if not cred:
        return None
    model = cred.model or cf.default_model
    url   = f"https://api.cloudflare.com/client/v4/accounts/{cred.account_id}/ai/run/{model}"
    hdrs  = {"Authorization": f"Bearer {cred.api_key}", "Content-Type": "application/json"}
    body  = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{screenshot_b64}"}},
                {"type": "text", "text": prompt_text},
            ],
        }]
    }
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(url, headers=hdrs, json=body)
        if r.status_code in (429, 403, 401):
            cf.mark_failed(cred)
            return None
        r.raise_for_status()
        data = r.json()
        return data.get("result", {}).get("response", "")
    except Exception as e:
        print(f"[Cloudflare] Vision error ({cred.label}): {e}", flush=True)
        cf.mark_failed(cred)
        return None


async def cloudflare_text(cf: CloudflarePool, messages: list, system: str = "") -> Optional[str]:
    """Call Cloudflare AI text-only. Rotates on failure."""
    if not cf.ready:
        return None
    cred = cf.next_credential()
    if not cred:
        return None
    model = cred.model or cf.default_model
    url   = f"https://api.cloudflare.com/client/v4/accounts/{cred.account_id}/ai/run/{model}"
    hdrs  = {"Authorization": f"Bearer {cred.api_key}", "Content-Type": "application/json"}
    msgs  = ([{"role": "system", "content": system}] if system else []) + messages
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(url, headers=hdrs, json={"messages": msgs})
        if r.status_code in (429, 403, 401):
            cf.mark_failed(cred)
            return None
        r.raise_for_status()
        return r.json().get("result", {}).get("response", "")
    except Exception as e:
        print(f"[Cloudflare] Text error ({cred.label}): {e}", flush=True)
        cf.mark_failed(cred)
        return None


# ── Supabase Logging ───────────────────────────────────────────────────────────
def log(task_id: str, message: str, log_type: str = "info", supabase=None):
    icons = {"info": "ℹ", "success": "✓", "error": "✗", "warning": "⚠", "screenshot": "📸"}
    print(f"{icons.get(log_type, 'ℹ')} {message[:200]}", flush=True)
    if supabase and task_id:
        try:
            supabase.table("task_logs").insert({
                "task_id":    task_id,
                "message":    message,
                "log_type":   log_type,
                "created_at": datetime.utcnow().isoformat(),
            }).execute()
        except Exception as e:
            print(f"[WARN] log: {e}", flush=True)


def log_screenshot(task_id: str, b64: str, label: str, supabase=None):
    """Store screenshot as base64 in task_logs with log_type=screenshot."""
    print(f"📸 Screenshot: {label}", flush=True)
    if supabase and task_id:
        try:
            supabase.table("task_logs").insert({
                "task_id":    task_id,
                "message":    b64,  # raw base64 — UI renders as <img>
                "log_type":   "screenshot",
                "created_at": datetime.utcnow().isoformat(),
            }).execute()
        except Exception as e:
            print(f"[WARN] screenshot log: {e}", flush=True)


# ── Screenshot Capture ─────────────────────────────────────────────────────────
async def capture_screenshot(page, task_id: str, step: int, label: str, supabase=None) -> Optional[str]:
    try:
        # Clip to viewport at 960px wide, 45% quality → keeps base64 under 150KB
        clip = {"x": 0, "y": 0, "width": 1366, "height": 768}
        buf  = await page.screenshot(type="jpeg", quality=45, full_page=False,
                                      clip=clip, timeout=10000)
        b64 = base64.b64encode(buf).decode()
        size_kb = len(b64) // 1024
        print(f"[Screenshot] Step {step}: {size_kb}KB — {label}", flush=True)
        # If still too large, re-shoot at lower quality
        if size_kb > 400:
            buf = await page.screenshot(type="jpeg", quality=25, full_page=False,
                                         clip=clip, timeout=10000)
            b64 = base64.b64encode(buf).decode()
            print(f"[Screenshot] Re-compressed to {len(b64)//1024}KB", flush=True)
        log_screenshot(task_id, b64, label, supabase)
        return b64
    except Exception as e:
        print(f"[Screenshot] Step {step} FAILED: {e}", flush=True)
        return None


# ── CAPTCHA Handler ────────────────────────────────────────────────────────────
async def handle_captcha(page, task_id: str, supabase=None, nopecha_key: str = "") -> bool:
    try:
        content = await page.content()
        url = page.url

        # Cloudflare JS challenge
        if ("Just a moment" in content or "Checking your browser" in content or
                ("cf-browser-verification" in content and "cloudflare" in content.lower())):
            log(task_id, "🛡️ Cloudflare challenge detected — waiting 15s…", "warning", supabase)
            await asyncio.sleep(15)
            new_content = await page.content()
            passed = "Just a moment" not in new_content and "Checking your browser" not in new_content
            log(task_id, "✅ CF challenge passed!" if passed else "⚠️ CF still blocking — continuing", "success" if passed else "warning", supabase)
            return True

        if not nopecha_key:
            if any(x in content.lower() for x in ["g-recaptcha", "hcaptcha", "cf-turnstile", "turnstile"]):
                log(task_id, "🔐 CAPTCHA detected (NopeCHA key not configured)", "warning", supabase)
            return False

        sitekey_m = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if not sitekey_m:
            return False

        sitekey = sitekey_m.group(1)
        if "hcaptcha" in content.lower():   ctype = "hcaptcha"
        elif "turnstile" in content.lower(): ctype = "turnstile"
        else:                                ctype = "recaptchav2"

        log(task_id, f"🔐 {ctype.upper()} detected — solving via NopeCHA…", "info", supabase)

        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post("https://api.nopecha.com/", json={
                "type": ctype, "sitekey": sitekey, "url": url, "key": nopecha_key,
            })
            data = res.json()
            if data.get("error"):
                log(task_id, f"NopeCHA error: {data['error']}", "warning", supabase)
                return False

            captcha_id = data.get("id")
            for _ in range(80):
                await asyncio.sleep(3)
                p = await client.get("https://api.nopecha.com/", params={"key": nopecha_key, "id": captcha_id})
                pd = p.json()
                if not pd.get("error") and pd.get("data"):
                    token = pd["data"][0] if isinstance(pd["data"], list) else pd["data"]
                    if ctype == "hcaptcha":
                        await page.evaluate(f"(() => {{ const r=document.querySelector('[name=\"h-captcha-response\"]'); if(r) r.value='{token}'; }})();")
                    elif ctype == "turnstile":
                        await page.evaluate(f"(() => {{ const r=document.querySelector('[name=\"cf-turnstile-response\"]'); if(r) r.value='{token}'; }})();")
                    else:
                        await page.evaluate(f"(() => {{ const r=document.getElementById('g-recaptcha-response'); if(r) r.innerHTML='{token}'; }})();")
                    log(task_id, "✅ CAPTCHA solved and token injected!", "success", supabase)
                    return True

        log(task_id, "⏰ CAPTCHA timeout", "warning", supabase)
        return False
    except Exception as e:
        log(task_id, f"CAPTCHA error: {e}", "warning", supabase)
        return False


# ── Page Context ───────────────────────────────────────────────────────────────
async def get_page_context(page, prompt: str, memory: List[str],
                            completed_extracts: List[str], last_extract_url: str = "") -> str:
    try:
        ctx = await page.evaluate("""() => {
            const getText = el => el ? (el.innerText || el.textContent || '').trim() : '';
            return {
                url:      location.href,
                title:    document.title,
                bodyText: getText(document.body).slice(0, 2500),
                inputs:   Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]),textarea,select'))
                              .slice(0,10).map(e => ({ tag:e.tagName, type:e.type||'', name:e.name||'', id:e.id||'', placeholder:e.placeholder||'' })),
                buttons:  Array.from(document.querySelectorAll('button,input[type=submit],[role=button]'))
                              .slice(0,10).map(e => ({ tag:e.tagName, id:e.id||'', text:getText(e).slice(0,60) })),
                links:    Array.from(document.querySelectorAll('a[href]'))
                              .slice(0,8).map(a => ({ text:getText(a).slice(0,50), href:a.href })),
                headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,5).map(getText),
                errors:   Array.from(document.querySelectorAll('[class*=error],[role=alert]')).slice(0,3).map(e => getText(e).slice(0,80)),
            };
        }""")
    except Exception:
        ctx = {"url": page.url, "title": "Unknown", "bodyText": "", "inputs": [], "buttons": [], "links": [], "headings": [], "errors": []}

    mem_str = ("\nEXTRACTED SO FAR:\n" + "\n".join(f"  • {m[:200]}" for m in memory[-6:])) if memory else ""
    done_str = f"\nCOMPLETED STEPS: {', '.join(completed_extracts)} — DONE, do NOT re-extract." if completed_extracts else ""
    next_hint = ""
    if completed_extracts and last_extract_url == ctx.get("url", ""):
        next_hint = "\n🚨 DATA ALREADY EXTRACTED FROM THIS PAGE. GOTO next URL or FINISH immediately."
    # Strong hint: if already on one of the prompt URLs, extract now
    prompt_urls = re.findall(r'https?://[^\s'"<>)]+', prompt)
    current_clean = ctx.get("url", "").rstrip("/").split("?")[0]
    on_target = any(current_clean.startswith(u.rstrip("/").split("?")[0]) for u in prompt_urls)
    if on_target and not memory:
        next_hint += "\n✅ YOU ARE ALREADY ON THE TARGET PAGE. Do NOT navigate again. EXTRACT data NOW using EXTRACT action."
    elif on_target and memory:
        next_hint += "\n📊 You have data. If all required info is collected, use FINISH. If not, EXTRACT more."

    return f"""URL: {ctx['url']}
TITLE: {ctx['title']}
HEADINGS: {' | '.join(ctx.get('headings', [])[:3])}
PAGE TEXT:\n{ctx.get('bodyText', '')[:1800]}
INPUTS: {json.dumps(ctx.get('inputs', [])[:6])}
BUTTONS: {json.dumps(ctx.get('buttons', [])[:8])}
LINKS: {json.dumps(ctx.get('links', [])[:6])}
ERRORS: {' | '.join(ctx.get('errors', []))}
TASK: {prompt}{done_str}{mem_str}{next_hint}"""


# ── JSON Extractor ─────────────────────────────────────────────────────────────
def extract_action_json(raw: str) -> Optional[dict]:
    text = re.sub(r'^```(?:json)?\s*', '', raw.strip(), flags=re.MULTILINE)
    text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE).strip()

    candidates = []
    if text.startswith('{') and text.endswith('}'):
        candidates.append(text)
    for pat in [r'\{[^{}]*"action"\s*:[^{}]*\}', r'\{[^{}]*\}', r'\{.*?\}']:
        m = re.search(pat, text, re.DOTALL)
        if m: candidates.append(m.group())

    for raw_json in candidates:
        fixed = re.sub(r',\s*([}\]])', r'\1', raw_json)
        fixed = re.sub(r"'([^']*)'", r'"\1"', fixed)
        fixed = fixed.replace('True', 'true').replace('False', 'false').replace('None', 'null')
        fixed = re.sub(r'//[^\n]*', '', fixed)
        try:
            obj = json.loads(fixed)
            if isinstance(obj, dict) and 'action' in obj:
                return obj
        except Exception:
            pass

    action_m = re.search(r'"action"\s*:\s*"(\w+)"', text)
    if action_m:
        reason_m = re.search(r'"reason"\s*:\s*"([^"]*)"', text)
        return {"action": action_m.group(1).upper(), "reason": reason_m.group(1) if reason_m else "repaired"}
    return None


# ── Main Agent Loop ────────────────────────────────────────────────────────────
async def run_agent(task_id: str, prompt: str,
                    cerebras_pool: Optional[CerebrasPool],
                    cf_pool: Optional[CloudflarePool],
                    supabase=None, nopecha_key: str = "") -> dict:
    from playwright.async_api import async_playwright

    log(task_id, "🚀 AutoAgent Pro — stealth browser starting…", "info", supabase)
    log(task_id, f"📋 Task: {prompt[:120]}{'…' if len(prompt) > 120 else ''}", "info", supabase)
    if cerebras_pool:
        log(task_id, f"⚡ Cerebras ready — {cerebras_pool.size} key(s)", "info", supabase)
    if cf_pool and cf_pool.ready:
        log(task_id, f"☁️ Cloudflare AI ready — {cf_pool.size} key(s), model: {cf_pool.model}", "info", supabase)

    memory: List[str] = []
    steps_done = 0
    max_steps  = 50
    final_summary = ""

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox", "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage", "--disable-gpu",
                "--window-size=1366,768", "--disable-extensions",
                "--disable-infobars", "--disable-default-apps",
                "--no-first-run",
            ]
        )
        ctx = await browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="America/New_York",
            extra_http_headers={
                "Accept-Language":  "en-US,en;q=0.9",
                "Accept":           "text/html,application/xhtml+xml,*/*;q=0.8",
                "sec-ch-ua":        '"Chromium";v="124","Google Chrome";v="124"',
                "sec-ch-ua-mobile": "?0",
            },
        )
        await ctx.add_init_script("""
            Object.defineProperty(navigator, 'webdriver',    { get: () => false });
            Object.defineProperty(navigator, 'plugins',      { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages',    { get: () => ['en-US','en'] });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            window.chrome = { runtime: {} };
            const origQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (p) =>
                p.name === 'notifications'
                    ? Promise.resolve({ state: 'denied' })
                    : origQuery(p);
        """)

        page = await ctx.new_page()

        # Initial navigation
        url_match = re.search(r'https?://[^\s\'"<>)]+', prompt)
        start_url = url_match.group() if url_match else "https://www.google.com"
        log(task_id, f"🌐 Navigating to {start_url}", "info", supabase)
        try:
            await page.goto(start_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(random.uniform(1.2, 2.5))
        except Exception as e:
            log(task_id, f"Navigation error: {e}", "warning", supabase)

        await handle_captcha(page, task_id, supabase, nopecha_key)
        await capture_screenshot(page, task_id, 0, "Initial page load", supabase)

        # Agent loop vars
        recent_actions:    List[str] = []
        consecutive_waits: int       = 0
        completed_extracts: List[str] = []
        last_extract_url:  str        = ""
        extracted_urls:    List[str]  = []

        SYSTEM_PROMPT = """You are AutoAgent Pro — an expert autonomous browser agent.
Output ONLY ONE valid JSON action object. No markdown, no explanation, no text. ONLY JSON.

AVAILABLE ACTIONS:
{"action":"GOTO","url":"https://example.com","reason":"..."}
{"action":"CLICK","selector":"CSS_SELECTOR","reason":"..."}
{"action":"TYPE","selector":"CSS_SELECTOR","text":"text to type","reason":"..."}
{"action":"PRESS_KEY","key":"Enter","reason":"..."}
{"action":"SCROLL","scrollY":500,"reason":"..."}
{"action":"EXTRACT","js":"document.body.innerText.slice(0,2000)","label":"data_name","reason":"..."}
{"action":"WAIT","ms":2000,"reason":"..."}
{"action":"FINISH","summary":"complete summary of ALL data extracted","reason":"task complete"}

CRITICAL RULES (follow strictly):
1. Output ONLY raw JSON — no ``` markers, no text before/after
2. Use DOUBLE QUOTES for all strings
3. If you are ALREADY on the target URL: use EXTRACT immediately, NEVER use GOTO to the same URL
4. Use EXTRACT to collect data from the current page before moving on
5. After EXTRACTing data, either GOTO the next required URL or FINISH
6. Use FINISH when ALL required information has been collected
7. NEVER repeat the same action more than twice — if stuck, switch to EXTRACT or FINISH
8. For HN stories: use js="Array.from(document.querySelectorAll('.athing')).map(el=>el.innerText).join('\n').slice(0,2000)"
9. Good EXTRACT examples:
   - Links: "Array.from(document.querySelectorAll('a')).slice(0,20).map(a=>a.textContent+':'+a.href).join('\n')"
   - Text: "document.body.innerText.slice(0,3000)"
   - Title: "document.title"
   - HN titles: "Array.from(document.querySelectorAll('.titleline>a')).map(a=>a.textContent).join('\n')"
"""

        while steps_done < max_steps:
            steps_done += 1
            current_url = page.url
            log(task_id, f"⚙️ Step {steps_done}/{max_steps} — {current_url[:80]}", "info", supabase)

            # Screenshot every N steps
            ss_b64 = None
            if steps_done % SCREENSHOT_EVERY == 0:
                ss_b64 = await capture_screenshot(page, task_id, steps_done, f"Step {steps_done}", supabase)

            # Check CAPTCHA
            await handle_captcha(page, task_id, supabase, nopecha_key)

            # ── Loop detection (much stricter) ────────────────────────────
            # Count how many of last 6 actions are the same TYPE
            recent_types = [a.split(":")[0] for a in recent_actions[-6:]]
            type_counts  = {t: recent_types.count(t) for t in set(recent_types)}
            dominant_type = max(type_counts, key=type_counts.get) if type_counts else ""
            dominant_count = type_counts.get(dominant_type, 0)

            if dominant_count >= 4:
                # Stuck in a loop — force EXTRACT if no data yet, else FINISH
                log(task_id, f"⚠️ Loop detected ({dominant_type}×{dominant_count}) — forcing EXTRACT/FINISH", "warning", supabase)
                if memory:
                    final_summary = "Extracted data:\n" + "\n".join(f"• {m}" for m in memory)
                    log(task_id, f"🏁 Forced finish with collected data", "success", supabase)
                else:
                    # Force an EXTRACT of whatever is on the page
                    try:
                        fallback = await page.evaluate("document.body.innerText.slice(0,2000)")
                        memory.append(f"page_content: {str(fallback)[:800]}")
                        final_summary = f"Forced extraction after loop\n\n{memory[0]}"
                        log(task_id, f"📊 Forced page text extraction: {str(fallback)[:200]}", "success", supabase)
                    except Exception as fe:
                        final_summary = f"Loop detected — no data collected. Error: {fe}"
                break

            if consecutive_waits >= 5:
                log(task_id, "⚠️ Too many WAITs — forcing finish", "warning", supabase)
                final_summary = f"Timeout. Collected: {' | '.join(memory)}"
                break

            # ── Decide next action ────────────────────────────────────────────
            action: Optional[dict] = None
            loop_hint = ""
            if consecutive_waits >= 2:
                loop_hint = "\n⚠️ Output ONLY raw JSON — no text before or after."
            if dominant_count >= 2:
                loop_hint += (
                    f"\n🚨 You have done {dominant_type} {dominant_count} times in a row. "
                    f"Switch to a DIFFERENT action. If on target page, use EXTRACT."
                )
            if dominant_count >= 3:
                loop_hint += "\n🔴 CRITICAL: Do NOT repeat the same action. Use EXTRACT or FINISH NOW."

            page_ctx = await get_page_context(page, prompt, memory, completed_extracts, last_extract_url)
            system = SYSTEM_PROMPT + loop_hint

            # 1) Try Cerebras (primary)
            if cerebras_pool:
                try:
                    raw = await cerebras_chat(cerebras_pool, [{"role": "user", "content": page_ctx}], system=system, max_tokens=400)
                    action = extract_action_json(raw)
                except Exception as e:
                    log(task_id, f"⚠️ Cerebras error: {str(e)[:80]}", "warning", supabase)

            # 2) Cloudflare text fallback
            if not action and cf_pool and cf_pool.ready:
                try:
                    raw = await cloudflare_text(cf_pool, [{"role": "user", "content": page_ctx}], system=system)
                    if raw:
                        action = extract_action_json(raw)
                        if action:
                            log(task_id, "☁️ Cloudflare AI fallback used", "info", supabase)
                except Exception as e:
                    log(task_id, f"⚠️ Cloudflare fallback error: {str(e)[:80]}", "warning", supabase)

            # 3) Cloudflare vision (when screenshot available & text reasoning failed)
            if not action and cf_pool and cf_pool.ready and ss_b64:
                try:
                    vision_prompt = (
                        f"OBJECTIVE: {prompt}\n"
                        f"URL: {page.url}\nStep: {steps_done}\n\n"
                        f"Analyse this screenshot and return ONE JSON action:\n"
                        f'{{\"action\":\"CLICK|TYPE|GOTO|SCROLL|EXTRACT|FINISH\",\"selector\":\"CSS\",\"text\":\"\",\"url\":\"\",\"reason\":\"why\"}}\n'
                        f"Raw JSON only."
                    )
                    raw = await cloudflare_vision(cf_pool, ss_b64, vision_prompt)
                    if raw:
                        action = extract_action_json(raw)
                        if action:
                            log(task_id, "👁️ Cloudflare Vision used for decision", "info", supabase)
                except Exception as e:
                    log(task_id, f"⚠️ Vision error: {str(e)[:80]}", "warning", supabase)

            if not action:
                action = {"action": "WAIT", "ms": 2000, "reason": "AI unavailable"}

            action_type = action.get("action", "WAIT").upper()
            reason      = action.get("reason", "")
            log(task_id, f"🤖 {action_type}: {reason[:100]}", "info", supabase)

            # Track loops
            action_key = f"{action_type}:{str(action.get('url', action.get('selector', '')))[:50]}"
            recent_actions.append(action_key)
            if len(recent_actions) > 8: recent_actions.pop(0)
            consecutive_waits = consecutive_waits + 1 if action_type == "WAIT" else 0

            # ── Execute ───────────────────────────────────────────────────────
            if action_type == "FINISH":
                summary = action.get("summary", reason)
                final_summary = summary
                log(task_id, f"✅ Task complete!\n{summary[:600]}", "success", supabase)
                await capture_screenshot(page, task_id, steps_done, "Task completed", supabase)
                break

            elif action_type == "GOTO":
                target = action.get("url", "")
                if not target:
                    all_urls = re.findall(r'https?://[^\s\'"<>)]+', prompt)
                    cur = page.url.rstrip('/')
                    unextracted = [u for u in all_urls if u.rstrip('/') not in extracted_urls and u.rstrip('/') != cur]
                    different   = [u for u in all_urls if u.rstrip('/') != cur]
                    chosen = (unextracted or different or [None])[0]
                    if chosen: target = chosen; log(task_id, f"⚠️ GOTO missing url — auto: {target[:60]}", "warning", supabase)
                if target:
                    # Same-URL detection: skip no-op navigation, auto-EXTRACT instead
                    cur_host = page.url.lower().split("/")[2] if "://" in page.url else ""
                    tgt_host = target.lower().split("/")[2] if "://" in target else target.lower().split("/")[0]
                    cur_path = "/".join(page.url.rstrip("/").split("/")[3:])
                    tgt_path = "/".join(target.rstrip("/").split("/")[3:])
                    same_page = (cur_host == tgt_host and cur_path == tgt_path)
                    if same_page:
                        log(task_id, f"⚠️ Already on target page — skipping GOTO, auto-EXTRACTing", "warning", supabase)
                        try:
                            extracted_text = await page.evaluate("document.body.innerText.slice(0,2000)")
                            lbl = f"auto_extract_{steps_done}"
                            memory.append(f"{lbl}: {str(extracted_text)[:800]}")
                            if lbl not in completed_extracts: completed_extracts.append(lbl)
                            last_extract_url = page.url
                            log(task_id, f"📊 Auto-extracted (GOTO no-op): {str(extracted_text)[:200]}", "success", supabase)
                        except Exception as ae:
                            log(task_id, f"Auto-extract error: {str(ae)[:60]}", "warning", supabase)
                    else:
                        try:
                            log(task_id, f"🌐 Navigating to {target[:80]}", "info", supabase)
                            await page.goto(target, wait_until="domcontentloaded", timeout=30000)
                            await asyncio.sleep(random.uniform(1.0, 2.3))
                            await handle_captcha(page, task_id, supabase, nopecha_key)
                            await capture_screenshot(page, task_id, steps_done, f"After GOTO {target[:40]}", supabase)
                            recent_actions.clear()
                        except Exception as e:
                            log(task_id, f"Navigation error: {str(e)[:80]}", "warning", supabase)
            elif action_type == "CLICK":
                selector = action.get("selector", "")
                if selector:
                    try:
                        el = await page.wait_for_selector(selector, timeout=10000, state="visible")
                        if el:
                            bbox = await el.bounding_box()
                            if bbox:
                                await page.mouse.move(
                                    bbox["x"] + bbox["width"] / 2 + random.uniform(-3, 3),
                                    bbox["y"] + bbox["height"] / 2 + random.uniform(-3, 3),
                                )
                                await asyncio.sleep(random.uniform(0.05, 0.15))
                            await el.click()
                            await asyncio.sleep(random.uniform(0.4, 1.1))
                    except Exception as e:
                        log(task_id, f"Click error ({selector[:40]}): {str(e)[:80]}", "warning", supabase)
                        try: await page.evaluate(f'document.querySelector("{selector}")?.click()')
                        except: pass

            elif action_type == "TYPE":
                selector = action.get("selector", "")
                text     = action.get("text", "")
                if selector and text is not None:
                    try:
                        el = await page.wait_for_selector(selector, timeout=8000, state="visible")
                        if el:
                            await el.click(); await asyncio.sleep(0.1)
                            await el.triple_click(); await asyncio.sleep(0.1)
                            for char in str(text):
                                await page.keyboard.type(char, delay=random.randint(50, 140))
                                if random.random() < 0.04:
                                    await asyncio.sleep(random.uniform(0.2, 0.5))
                            log(task_id, f'⌨️ Typed "{str(text)[:40]}" → {selector[:40]}', "info", supabase)
                    except Exception as e:
                        log(task_id, f"Type error: {str(e)[:80]}", "warning", supabase)

            elif action_type == "PRESS_KEY":
                key = action.get("key", "Enter")
                await asyncio.sleep(random.uniform(0.1, 0.25))
                await page.keyboard.press(key)
                await asyncio.sleep(random.uniform(0.5, 1.4))
                log(task_id, f"⌨️ Pressed {key}", "info", supabase)

            elif action_type == "SCROLL":
                scroll_y = action.get("scrollY", 400)
                scroll_x = action.get("scrollX", 0)
                chunks = max(1, abs(scroll_y) // 120)
                for _ in range(chunks):
                    await page.mouse.wheel(scroll_x, scroll_y / chunks)
                    await asyncio.sleep(random.uniform(0.06, 0.13))
                await asyncio.sleep(random.uniform(0.3, 0.7))

            elif action_type == "EXTRACT":
                js_expr = action.get("js") or "document.body.innerText.slice(0,1000)"
                label   = action.get("label", "data")
                try:
                    extracted = await page.evaluate(js_expr)
                    if extracted is None:
                        extracted = await page.evaluate("document.body.innerText.slice(0,500)")
                    extracted_str = str(extracted)[:600]
                    memory.append(f"{label}: {extracted_str}")
                    log(task_id, f"📊 Extracted [{label}]: {extracted_str[:250]}", "success", supabase)
                    if label not in completed_extracts: completed_extracts.append(label)
                    last_extract_url = page.url
                    if page.url.rstrip('/') not in extracted_urls: extracted_urls.append(page.url.rstrip('/'))
                    consecutive_waits = 0
                    recent_actions.clear()
                except Exception as e:
                    log(task_id, f"Extract error: {str(e)[:80]}", "warning", supabase)
                    try:
                        fallback = await page.evaluate("document.body.innerText.slice(0,300)")
                        memory.append(f"{label}-fallback: {fallback}")
                        log(task_id, f"📊 Fallback extract [{label}]: {str(fallback)[:150]}", "success", supabase)
                    except: pass

            elif action_type == "WAIT":
                ms = min(action.get("ms", 2000), 8000)
                await asyncio.sleep(ms / 1000)

            elif action_type == "HOVER":
                selector = action.get("selector", "")
                if selector:
                    try:
                        await page.hover(selector, timeout=5000)
                        await asyncio.sleep(random.uniform(0.3, 0.7))
                    except: pass

            # Inter-step delay
            await asyncio.sleep(random.uniform(0.4, 1.0))

        # ── Final ──────────────────────────────────────────────────────────────
        if not final_summary:
            final_summary = f"Completed {steps_done} steps."
            log(task_id, f"🏁 Agent finished {steps_done} steps", "success", supabase)
            await capture_screenshot(page, task_id, steps_done, "Final state", supabase)

        result_summary = final_summary
        if memory:
            result_summary += "\n\nEXTRACTED DATA:\n" + "\n".join(f"• {m}" for m in memory)

        await browser.close()
        return {"success": True, "summary": result_summary[:2000], "steps": steps_done, "memory": memory}


# ── Task Runner ────────────────────────────────────────────────────────────────
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

    prompt  = task.get("prompt", "")
    user_id = task.get("user_id", "")

    # Load user settings (Cerebras + Cloudflare)
    cerebras_keys: List[str] = []
    cf_account_id = CF_ACCOUNT_ID_ENV
    cf_keys:       List[str] = [k.strip() for k in CF_API_KEY_ENV.split(",") if k.strip()]
    cf_model       = CF_MODEL_ENV or "@cf/moonshotai/kimi-k2.6"
    nopecha_key    = NOPECHA_KEY

    if supabase and user_id:
        try:
            sr = supabase.table("settings").select(
                "cerebras_keys,cloudflare_account_id,cloudflare_keys,cloudflare_model,nopecha_key"
            ).eq("user_id", user_id).execute()
            for row in (sr.data or []):
                cerebras_keys.extend(row.get("cerebras_keys") or [])
                if row.get("cloudflare_account_id"):
                    cf_account_id = row["cloudflare_account_id"]
                if row.get("cloudflare_keys"):
                    cf_keys = row["cloudflare_keys"]
                if row.get("cloudflare_model"):
                    cf_model = row["cloudflare_model"]
                if row.get("nopecha_key"):
                    nopecha_key = row["nopecha_key"]
        except Exception as e:
            print(f"[WARN] Settings: {e}", flush=True)

    # Env-override Cerebras keys
    env_cerebras = [k.strip() for k in os.environ.get("CEREBRAS_API_KEYS", "").split(",") if k.strip()]
    cerebras_keys.extend(env_cerebras)
    cerebras_keys = list(dict.fromkeys(cerebras_keys))

    cerebras_pool = CerebrasPool(cerebras_keys) if cerebras_keys else None
    cf_credentials = parse_cf_credentials(cf_keys, cf_account_id, cf_model)
    cf_pool        = CloudflarePool(cf_credentials, cf_model) if cf_credentials else None

    if cerebras_pool:
        print(f"[Cerebras] Pool ready: {cerebras_pool.size} key(s)", flush=True)
    if cf_pool and cf_pool.ready:
        models = list(set(c.model for c in cf_pool.credentials))
        print(f"[Cloudflare] Pool ready: {cf_pool.size} credential(s), models: {', '.join(models[:3])}", flush=True)
    if not cerebras_pool and (not cf_pool or not cf_pool.ready):
        print("[WARN] No AI providers configured — agent will use WAIT fallback", flush=True)

    # Mark running
    if supabase:
        supabase.table("tasks").update({
            "status":   "running",
            "last_run": datetime.utcnow().isoformat(),
        }).eq("id", task_id).execute()

    log(task_id, "🤖 AutoAgent Pro starting…", "info", supabase)

    result = {"success": False, "summary": "", "steps": 0}
    try:
        result = await run_agent(task_id, prompt, cerebras_pool, cf_pool, supabase, nopecha_key)
    except Exception as e:
        log(task_id, f"❌ Agent crashed: {e}", "error", supabase)
        traceback.print_exc()
        result = {"success": False, "summary": str(e)[:500], "steps": 0}

    # Save result
    if supabase:
        supabase.table("tasks").update({
            "status":     "completed" if result["success"] else "failed",
            "result":     json.dumps({
                "success":     result["success"],
                "summary":     result.get("summary", "")[:2000],
                "stepCount":   result.get("steps", 0),
                "completedAt": datetime.utcnow().isoformat(),
            }),
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", task_id).execute()

    status = "✅ SUCCESS" if result["success"] else "❌ FAILED"
    log(task_id, f"{status} — {result.get('steps', 0)} steps | {result.get('summary', '')[:150]}",
        "success" if result["success"] else "error", supabase)


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TASK_ID", "")
    if not tid:
        print("Usage: python scripts/browser_use_worker.py <task_id>", flush=True)
        sys.exit(1)
    asyncio.run(run_task(tid))
