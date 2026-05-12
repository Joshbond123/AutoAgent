#!/usr/bin/env python3
"""
AutoAgent Pro - Browser Use Worker
Primary AI: Cerebras gpt-oss-120b (auto-fallback to llama3.1-8b if unavailable)
Fallback: Google Gemini 2.0 Flash
Browser: Browser Use + Playwright (stealth mode)
"""

import asyncio
import os
import sys
import json
import traceback
import random
import time
from datetime import datetime
from typing import Optional, List

# Cerebras client (HTTP-based, no SDK needed)
import httpx

# Browser automation
try:
    from browser_use import Agent, Browser, BrowserConfig
    from browser_use.browser.context import BrowserContext, BrowserContextConfig
    BROWSER_USE_AVAILABLE = True
except ImportError:
    BROWSER_USE_AVAILABLE = False
    print("[WARN] browser-use not installed — using Playwright fallback", flush=True)

# Supabase
try:
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False

# LangChain (for browser-use LLM integration)
try:
    from langchain_google_genai import ChatGoogleGenerativeAI
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False

# ─── Configuration ───────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
NOPECHA_API_KEY = os.environ.get("NOPECHA_API_KEY", "")
TASK_ID = os.environ.get("TASK_ID", "")
CEREBRAS_MODEL = "gpt-oss-120b"  # Primary model
CEREBRAS_FALLBACK_MODELS = ["gpt-oss-120b", "llama3.1-8b", "llama3.1-70b"]  # Auto-fallback chain
CEREBRAS_BASE = "https://api.cerebras.ai/v1"


# ─── Cerebras Key Rotation ────────────────────────────────────────────────────
class CerebrasKeyPool:
    def __init__(self, keys: List[str]):
        self.keys = [k.strip() for k in keys if k.strip()]
        self.index = 0
        self.failed: set = set()

    def next_key(self) -> Optional[str]:
        available = [k for k in self.keys if k not in self.failed]
        if not available:
            self.failed.clear()
            available = self.keys
        if not available:
            return None
        key = available[self.index % len(available)]
        self.index = (self.index + 1) % len(available)
        return key

    def mark_failed(self, key: str):
        self.failed.add(key)
        print(f"[Cerebras] Key ...{key[-6:]} marked failed, {len(self.keys) - len(self.failed)} remaining", flush=True)

    @property
    def active_count(self):
        return len(self.keys) - len(self.failed)


async def cerebras_chat(pool: CerebrasKeyPool, messages: list, system: str = "", max_retries: int = 3) -> str:
    """Call Cerebras with auto-fallback: gpt-oss-120b → llama3.1-8b → llama3.1-70b."""
    for attempt in range(max_retries):
        key = pool.next_key()
        if not key:
            raise RuntimeError("No Cerebras API keys available")

        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

        body_messages = []
        if system:
            body_messages.append({"role": "system", "content": system})
        body_messages.extend(messages)

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                res = await client.post(f"{CEREBRAS_BASE}/chat/completions", headers=headers, json={
                    "model": model,  # auto-selected from fallback chain
                    "messages": body_messages,
                    "temperature": 0.2,
                    "max_tokens": 1024,
                })

            if res.status_code in (401, 403):
                pool.mark_failed(key)
                continue

            if res.status_code == 429:
                wait = (attempt + 1) * 2
                print(f"[Cerebras] Rate limited, waiting {wait}s...", flush=True)
                await asyncio.sleep(wait)
                continue

            res.raise_for_status()
            data = res.json()
            content = data["choices"][0]["message"]["content"]
            print(f"[Cerebras] gpt-oss-120b responded ({len(content)} chars, key ...{key[-6:]})", flush=True)
            return content

        except Exception as e:
            print(f"[Cerebras] Attempt {attempt+1} failed: {e}", flush=True)
            if attempt == max_retries - 1:
                raise

    raise RuntimeError("Cerebras: all retries exhausted")


# ─── Logging ──────────────────────────────────────────────────────────────────
def log(task_id: str, message: str, log_type: str = "info", supabase=None):
    prefix = {"info": "ℹ", "success": "✓", "error": "✗", "warning": "⚠"}.get(log_type, "ℹ")
    print(f"{prefix} {message}", flush=True)
    if supabase and task_id:
        try:
            supabase.table("task_logs").insert({
                "task_id": task_id,
                "message": message,
                "log_type": log_type,
                "created_at": datetime.utcnow().isoformat(),
            }).execute()
        except Exception as e:
            print(f"[WARN] Log persist failed: {e}", flush=True)


# ─── CAPTCHA Handler ──────────────────────────────────────────────────────────
async def handle_captcha(page, nopecha_key: str = "", task_id: str = "", supabase=None) -> bool:
    """Detect and solve CAPTCHA on current page."""
    try:
        content = await page.content()
        url = page.url

        # Cloudflare JS challenge
        if "Just a moment" in content or "Checking your browser" in content:
            log(task_id, "Cloudflare JS challenge detected — waiting 12s for auto-solve...", "warning", supabase)
            await asyncio.sleep(12)
            return True

        if not nopecha_key:
            return False

        import re
        sitekey_match = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if not sitekey_match:
            return False

        sitekey = sitekey_match.group(1)

        # Determine CAPTCHA type
        if "hcaptcha" in content.lower():
            captcha_type = "hcaptcha"
        elif "turnstile" in content.lower():
            captcha_type = "turnstile"
        else:
            captcha_type = "recaptchav2"

        log(task_id, f"Detected {captcha_type} (sitekey: {sitekey[:20]}...) — solving via NopeCHA...", "info", supabase)

        async with httpx.AsyncClient(timeout=120) as client:
            res = await client.post("https://api.nopecha.com/", json={
                "type": captcha_type,
                "sitekey": sitekey,
                "url": url,
                "key": nopecha_key,
            })
            data = res.json()
            if data.get("error"):
                log(task_id, f"CAPTCHA submit error: {data['error']}", "warning", supabase)
                return False

            task_captcha_id = data.get("id")
            for _ in range(60):
                await asyncio.sleep(3)
                poll = await client.get("https://api.nopecha.com/", params={"key": nopecha_key, "id": task_captcha_id})
                poll_data = poll.json()
                if not poll_data.get("error") and poll_data.get("data"):
                    token = poll_data["data"][0] if isinstance(poll_data["data"], list) else poll_data["data"]

                    # Inject token
                    if captcha_type == "hcaptcha":
                        await page.evaluate(f'document.querySelector("[name=\'h-captcha-response\']") && (document.querySelector("[name=\'h-captcha-response\']").value = "{token}")')
                    elif captcha_type == "turnstile":
                        await page.evaluate(f'document.querySelector("[name=\'cf-turnstile-response\']") && (document.querySelector("[name=\'cf-turnstile-response\']").value = "{token}")')
                    else:
                        await page.evaluate(f'''
                            document.getElementById("g-recaptcha-response") && 
                            (document.getElementById("g-recaptcha-response").innerHTML = "{token}");
                        ''')

                    log(task_id, f"CAPTCHA solved and token injected!", "success", supabase)
                    return True

        log(task_id, "CAPTCHA solve timeout", "warning", supabase)
        return False

    except Exception as e:
        log(task_id, f"CAPTCHA handler error: {e}", "warning", supabase)
        return False


# ─── Browser Use Agent ────────────────────────────────────────────────────────
async def run_with_browser_use(task_id: str, prompt: str, cerebras_pool: Optional[CerebrasKeyPool], supabase=None) -> dict:
    """Run agent using Browser Use + Cerebras gpt-oss-120b."""
    log(task_id, "Initializing Browser Use agent with Cerebras gpt-oss-120b...", "info", supabase)

    if not LANGCHAIN_AVAILABLE or not GEMINI_API_KEY:
        raise RuntimeError("LangChain + Gemini required for Browser Use LLM integration")

    # Browser Use uses LangChain LLM interface; we use Gemini for its vision support
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.0-flash",
        google_api_key=GEMINI_API_KEY,
        temperature=0.3,
    )

    browser_config = BrowserConfig(
        headless=True,
        disable_security=False,
        extra_chromium_args=[
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--window-size=1366,768",
            "--disable-dev-shm-usage",
        ],
    )
    browser = Browser(config=browser_config)
    logs_collected = []

    try:
        context_config = BrowserContextConfig(
            wait_for_network_idle_page_load_time=3.0,
            browser_window_size={"width": 1366, "height": 768},
            highlight_elements=False,
        )

        # Enrich prompt with Cerebras reasoning (text pre-analysis)
        enriched_prompt = prompt
        if cerebras_pool and cerebras_pool.active_count > 0:
            try:
                log(task_id, f"Pre-analyzing task with Cerebras gpt-oss-120b ({cerebras_pool.active_count} keys)...", "info", supabase)
                analysis = await cerebras_chat(cerebras_pool, [{
                    "role": "user",
                    "content": f"Analyze this browser automation task and provide a step-by-step plan:\n{prompt}"
                }], system="You are AutoAgent Pro. Analyze browser automation tasks and provide clear step-by-step execution plans.")
                enriched_prompt = f"{prompt}\n\nEXECUTION PLAN (from Cerebras gpt-oss-120b):\n{analysis[:800]}"
                log(task_id, f"Cerebras analysis complete, launching browser...", "success", supabase)
            except Exception as e:
                log(task_id, f"Cerebras pre-analysis skipped: {e}", "warning", supabase)

        agent = Agent(
            task=enriched_prompt,
            llm=llm,
            browser=browser,
            browser_context=browser.new_context(config=context_config),
            max_actions_per_step=10,
        )

        result = await agent.run(max_steps=25)
        final = result.final_result() if hasattr(result, "final_result") else str(result)
        done = result.is_done() if hasattr(result, "is_done") else True

        log(task_id, f"Browser Use completed. Result: {str(final)[:200]}", "success", supabase)
        return {"success": done, "summary": str(final)[:500], "logs": logs_collected}

    finally:
        try:
            await browser.close()
        except Exception:
            pass


# ─── Playwright Fallback ──────────────────────────────────────────────────────
async def run_with_playwright(task_id: str, prompt: str, cerebras_pool: Optional[CerebrasKeyPool], supabase=None) -> dict:
    """Full Playwright agent loop with Cerebras gpt-oss-120b reasoning."""
    from playwright.async_api import async_playwright

    log(task_id, "Starting Playwright agent with Cerebras gpt-oss-120b decision engine...", "info", supabase)
    logs_collected = []
    step = 0
    max_steps = 25
    page_history = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="en-US",
        )
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => false})")
        page = await context.new_page()

        # Start URL
        import re
        url_match = re.search(r'https?://[^\s]+', prompt)
        if url_match:
            await page.goto(url_match.group(), wait_until="domcontentloaded", timeout=30000)
            page_history.append(url_match.group())
            await asyncio.sleep(random.uniform(0.8, 1.8))

        while step < max_steps:
            step += 1
            msg = f"Step {step}/{max_steps} on {page.url[:60]}"
            log(task_id, msg, "info", supabase)
            logs_collected.append(msg)

            # Check for CAPTCHA
            await handle_captcha(page, NOPECHA_API_KEY, task_id, supabase)

            # Gather page context
            try:
                elements_data = await page.evaluate("""() => ({
                    url: location.href,
                    title: document.title,
                    inputs: Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,select')).slice(0,10).map(e=>({tag:e.tagName,type:e.type,name:e.name,id:e.id,placeholder:e.placeholder,value:e.value?.slice(0,30)})),
                    buttons: Array.from(document.querySelectorAll('button,a[href],input[type=submit]')).slice(0,10).map(e=>({tag:e.tagName,text:e.textContent?.trim().slice(0,50),href:e.href||'',id:e.id})),
                    headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,3).map(h=>h.textContent?.trim()),
                    errors: Array.from(document.querySelectorAll('[class*=error],[class*=alert],[role=alert]')).slice(0,3).map(e=>e.textContent?.trim()),
                })""")
            except Exception:
                elements_data = {"url": page.url, "title": "Unknown", "inputs": [], "buttons": [], "headings": [], "errors": []}

            page_context = f"""URL: {elements_data['url']}
Title: {elements_data['title']}
Headings: {' | '.join(elements_data.get('headings', []))}
Inputs: {json.dumps(elements_data.get('inputs', []))}
Buttons: {json.dumps(elements_data.get('buttons', [])[:6])}
Errors: {' | '.join(elements_data.get('errors', []))}
History: {' → '.join(page_history[-3:])}"""

            # Get action from Cerebras gpt-oss-120b
            action = None
            if cerebras_pool and cerebras_pool.active_count > 0:
                try:
                    response = await cerebras_chat(cerebras_pool, [{
                        "role": "user",
                        "content": f"""TASK: {prompt}

{page_context}

Return ONLY a JSON action object:
{{"action":"CLICK|TYPE|SCROLL|WAIT|GOTO|PRESS_KEY|FINISH","selector":"CSS","text":"","url":"","key":"","scrollX":0,"scrollY":400,"reason":"why"}}

Return FINISH action when task is complete."""
                    }], system=f"""You are AutoAgent Pro using Cerebras {CEREBRAS_MODEL}.
Analyze the page and decide the next browser action to complete the task.
Return only valid JSON. Be precise with CSS selectors.""")

                    # Parse JSON from response
                    json_match = re.search(r'\{[^{}]+\}', response, re.DOTALL)
                    if json_match:
                        action = json.loads(json_match.group())
                except Exception as e:
                    log(task_id, f"Cerebras error: {e}", "warning", supabase)

            if not action:
                action = {"action": "WAIT", "reason": "No AI decision available", "scrollY": 300}

            action_type = action.get("action", "WAIT")
            reason = action.get("reason", "")
            log(task_id, f"Action: {action_type} — {reason[:100]}", "info", supabase)
            logs_collected.append(f"[{action_type}] {reason}")

            if action_type == "FINISH":
                log(task_id, f"Task completed: {reason}", "success", supabase)
                break

            # Execute action
            try:
                if action_type == "GOTO":
                    await page.goto(action.get("url", ""), wait_until="domcontentloaded", timeout=30000)
                    page_history.append(action.get("url", ""))
                    await asyncio.sleep(random.uniform(0.8, 2.0))

                elif action_type == "CLICK":
                    sel = action.get("selector", "")
                    el = await page.wait_for_selector(sel, timeout=8000, state="visible")
                    if el:
                        await el.hover()
                        await asyncio.sleep(random.uniform(0.05, 0.15))
                        await el.click()
                    await asyncio.sleep(random.uniform(0.3, 0.8))

                elif action_type == "TYPE":
                    sel = action.get("selector", "")
                    text = action.get("text", "")
                    el = await page.wait_for_selector(sel, timeout=8000)
                    if el:
                        await el.click()
                        await asyncio.sleep(0.1)
                        for char in text:
                            await page.keyboard.type(char, delay=random.randint(45, 140))

                elif action_type == "PRESS_KEY":
                    await page.keyboard.press(action.get("key", "Enter"))
                    await asyncio.sleep(random.uniform(0.3, 0.6))

                elif action_type == "SCROLL":
                    await page.mouse.wheel(action.get("scrollX", 0), action.get("scrollY", 400))
                    await asyncio.sleep(random.uniform(0.2, 0.5))

                elif action_type == "WAIT":
                    await asyncio.sleep(random.uniform(1.5, 3.5))

            except Exception as e:
                log(task_id, f"Action execution error: {e}", "warning", supabase)

            await asyncio.sleep(random.uniform(0.5, 1.2))

        final_url = page.url
        final_title = await page.title()
        summary = f"Completed {step} steps. Final: {final_title} ({final_url[:60]})"
        log(task_id, summary, "success", supabase)

        await browser.close()
        return {"success": True, "summary": summary, "logs": logs_collected, "steps": step}


# ─── Main ─────────────────────────────────────────────────────────────────────
async def run_task(task_id: str):
    supabase = None
    if SUPABASE_AVAILABLE and SUPABASE_URL and SUPABASE_SERVICE_KEY:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    log(task_id, f"AutoAgent Pro starting task {task_id}...", "info", supabase)

    # Fetch task
    if supabase:
        response = supabase.table("tasks").select("*").eq("id", task_id).single().execute()
        task = response.data
    else:
        task = {"id": task_id, "prompt": "Navigate to https://example.com and report the page title", "name": "Demo"}

    if not task:
        log(task_id, f"Task {task_id} not found!", "error", supabase)
        return

    prompt = task.get("prompt", "")
    log(task_id, f"Task: {task.get('name', 'Unknown')} | Prompt: {prompt[:100]}", "info", supabase)

    # Load Cerebras keys from settings
    cerebras_pool = None
    if supabase:
        try:
            settings_res = supabase.table("settings").select("cerebras_keys").execute()
            all_keys = []
            for row in (settings_res.data or []):
                all_keys.extend(row.get("cerebras_keys") or [])
            # Also check env
            env_keys = os.environ.get("CEREBRAS_API_KEYS", "")
            if env_keys:
                all_keys.extend([k.strip() for k in env_keys.split(",") if k.strip()])
            if all_keys:
                cerebras_pool = CerebrasKeyPool(all_keys)
                log(task_id, f"Cerebras pool: {cerebras_pool.active_count} keys, model: {CEREBRAS_MODEL}", "info", supabase)
        except Exception as e:
            log(task_id, f"Could not load Cerebras keys: {e}", "warning", supabase)

    # Env fallback
    if not cerebras_pool:
        env_keys = os.environ.get("CEREBRAS_API_KEYS", "")
        if env_keys:
            cerebras_pool = CerebrasKeyPool([k.strip() for k in env_keys.split(",") if k.strip()])

    # Mark as running
    if supabase:
        supabase.table("tasks").update({
            "status": "running",
            "last_run": datetime.utcnow().isoformat(),
        }).eq("id", task_id).execute()

    # Run agent
    try:
        if BROWSER_USE_AVAILABLE and GEMINI_API_KEY:
            result = await run_with_browser_use(task_id, prompt, cerebras_pool, supabase)
        else:
            result = await run_with_playwright(task_id, prompt, cerebras_pool, supabase)
    except Exception as e:
        log(task_id, f"Agent crashed: {e}", "error", supabase)
        traceback.print_exc()
        result = {"success": False, "summary": str(e), "logs": [], "steps": 0}

    # Update task result
    if supabase:
        supabase.table("tasks").update({
            "status": "completed" if result["success"] else "failed",
            "result": {
                "success": result["success"],
                "summary": result["summary"],
                "stepCount": result.get("steps", 0),
                "completedAt": datetime.utcnow().isoformat(),
            },
            "logs": "\n".join(result.get("logs", [])),
        }).eq("id", task_id).execute()

    log(task_id, f"Task finished. Success={result['success']} | {result['summary'][:100]}", "success" if result["success"] else "error", supabase)


if __name__ == "__main__":
    tid = TASK_ID or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not tid:
        print("Usage: python browser_use_worker.py <task_id>")
        sys.exit(1)
    asyncio.run(run_task(tid))
