#!/usr/bin/env python3
"""
AutoAgent Pro — Browser-Use Worker v5
Uses the browser-use library for AI-controlled browser automation.
Primary LLM:  Cerebras (via LangChain OpenAI-compatible wrapper)
Fallback LLM: Cloudflare Workers AI text model
Browser:      browser-use (built on Playwright, stealth, headless)
Screenshots:  Streamed to Supabase task_logs in real-time
"""

import asyncio, os, sys, json, base64, time, random, re, traceback
from datetime import datetime
from typing import Optional, List, Any
import urllib.request as _ur

# ── Optional deps ──────────────────────────────────────────────────────────────
try:
    import httpx
    HTTPX_OK = True
except ImportError:
    HTTPX_OK = False
    print("[WARN] httpx not installed", flush=True)

try:
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("[WARN] supabase not installed — logs will go to stdout only", flush=True)

try:
    from browser_use import Agent
    # Browser/BrowserConfig location varies by version
    try:
        from browser_use import Browser, BrowserConfig
    except ImportError:
        try:
            from browser_use.browser.browser import Browser, BrowserConfig
        except ImportError:
            Browser = None
            BrowserConfig = None
    # BrowserContextConfig may not exist in all versions
    try:
        from browser_use.browser.context import BrowserContextConfig
    except ImportError:
        BrowserContextConfig = None
    BROWSER_USE_OK = True
except ImportError as _e:
    BROWSER_USE_OK = False
    Agent = None
    Browser = None
    BrowserConfig = None
    BrowserContextConfig = None
    print(f"[ERROR] browser-use not installed: {_e}", flush=True)
    print("[ERROR] Run: pip install browser-use==0.1.40 langchain-openai", flush=True)

try:
    from langchain_openai import ChatOpenAI
    LANGCHAIN_OK = True
except ImportError:
    LANGCHAIN_OK = False
    print("[WARN] langchain-openai not installed", flush=True)

# ── Config ─────────────────────────────────────────────────────────────────────
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "")
SUPABASE_SVC_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
NOPECHA_KEY      = os.environ.get("NOPECHA_API_KEY", "")
CEREBRAS_BASE    = "https://api.cerebras.ai/v1"

CEREBRAS_MODELS = [
    "llama-3.3-70b",        # primary — best tool/structured-output support
    "llama3.1-8b",          # last resort — weak tool calling, may loop
]

CF_ACCOUNT_ID_ENV = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CF_API_KEY_ENV    = os.environ.get("CLOUDFLARE_API_KEY", "")
CF_MODEL_ENV      = os.environ.get("CLOUDFLARE_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")

SCREENSHOT_EVERY = 2  # capture a screenshot every N steps


# ── Supabase logging ───────────────────────────────────────────────────────────
def log(task_id: str, message: str, log_type: str = "info", supabase=None):
    icons = {"info": "ℹ", "success": "✓", "error": "✗", "warning": "⚠", "screenshot": "📸"}
    print(f"{icons.get(log_type, 'ℹ')} [{log_type.upper()}] {message[:300]}", flush=True)
    if supabase and task_id:
        try:
            supabase.table("task_logs").insert({
                "task_id":    task_id,
                "message":    message[:2000],
                "log_type":   log_type,
                "created_at": datetime.utcnow().isoformat(),
            }).execute()
        except Exception as e:
            print(f"[WARN] log insert: {e}", flush=True)


def log_screenshot(task_id: str, b64: str, label: str, supabase=None):
    """Store a base64 screenshot in task_logs via direct REST (bypasses supabase-py size limits)."""
    size_kb = len(b64) // 1024
    print(f"📸 Screenshot ({size_kb}KB): {label}", flush=True)
    if not (SUPABASE_URL and SUPABASE_SVC_KEY and task_id):
        return
    try:
        payload = json.dumps({
            "task_id":    task_id,
            "message":    b64,
            "log_type":   "screenshot",
            "created_at": datetime.utcnow().isoformat(),
        }).encode("utf-8")
        req = _ur.Request(
            f"{SUPABASE_URL}/rest/v1/task_logs",
            data=payload, method="POST",
            headers={
                "Authorization": f"Bearer {SUPABASE_SVC_KEY}",
                "apikey":        SUPABASE_SVC_KEY,
                "Content-Type":  "application/json",
                "Prefer":        "return=minimal",
            }
        )
        with _ur.urlopen(req, timeout=20) as r:
            print(f"[Screenshot] Stored {size_kb}KB — HTTP {r.status}", flush=True)
    except Exception as e:
        print(f"[WARN] screenshot store failed: {e}", flush=True)


def update_task_status(task_id: str, status: str, result: dict = None, supabase=None):
    if not supabase:
        return
    payload = {"status": status, "updated_at": datetime.utcnow().isoformat()}
    if result:
        payload["result"] = json.dumps(result)
    try:
        supabase.table("tasks").update(payload).eq("id", task_id).execute()
        print(f"[Task] Status → {status}", flush=True)
    except Exception as e:
        print(f"[WARN] status update: {e}", flush=True)


# ── Cerebras key pool ──────────────────────────────────────────────────────────
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


def pick_cerebras_llm(pool: CerebrasPool, model: str = "llama3.1-8b") -> Optional[Any]:
    """Build a LangChain ChatOpenAI pointed at the Cerebras API."""
    if not LANGCHAIN_OK:
        return None
    key = pool.next_key()
    if not key:
        return None
    try:
        return ChatOpenAI(
            base_url=CEREBRAS_BASE,
            api_key=key,
            model=model,
            temperature=0.0,
            max_tokens=4096,
            timeout=60,
            max_retries=2,
        )
    except Exception as e:
        print(f"[Cerebras] LLM init error: {e}", flush=True)
        return None


# ── Cloudflare fallback LLM (custom LangChain wrapper) ────────────────────────
def _cf_text_sync(account_id: str, api_key: str, model: str, messages: list) -> str:
    """Synchronous Cloudflare text call used by the custom LLM wrapper."""
    import urllib.request as ur
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
    body = json.dumps({"messages": messages}).encode()
    req = ur.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type":  "application/json",
    })
    try:
        with ur.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
        result = data.get("result", {}) or {}
        choices = result.get("choices") or []
        if choices:
            return choices[0].get("message", {}).get("content", "") or ""
        return result.get("response", "") or ""
    except Exception as e:
        print(f"[Cloudflare] text error: {e}", flush=True)
        return ""


def make_cloudflare_llm(account_id: str, api_key: str, model: str) -> Optional[Any]:
    """Wrap Cloudflare AI as a LangChain BaseChatModel."""
    if not LANGCHAIN_OK:
        return None
    try:
        from langchain_core.language_models.chat_models import BaseChatModel
        from langchain_core.messages import BaseMessage, AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult
        from typing import Iterator

        class CloudflareChatModel(BaseChatModel):
            account_id: str
            api_key: str
            model: str

            def _generate(self, messages: List[BaseMessage], stop=None, run_manager=None, **kwargs) -> ChatResult:
                lc_messages = [{"role": "system" if m.type == "system" else "user" if m.type == "human" else "assistant", "content": str(m.content)} for m in messages]
                reply = _cf_text_sync(self.account_id, self.api_key, self.model, lc_messages)
                gen = ChatGeneration(message=AIMessage(content=reply or "I was unable to process this request."))
                return ChatResult(generations=[gen])

            @property
            def _llm_type(self) -> str:
                return "cloudflare"

        return CloudflareChatModel(account_id=account_id, api_key=api_key, model=model)
    except Exception as e:
        print(f"[Cloudflare] LLM wrapper error: {e}", flush=True)
        return None


# ── Screenshot helper ──────────────────────────────────────────────────────────
async def take_page_screenshot(browser_session, task_id: str, step: int, label: str, supabase=None) -> Optional[str]:
    """Capture a screenshot from the active browser page."""
    try:
        # browser-use stores the current page in the browser session
        page = None
        try:
            if hasattr(browser_session, "get_current_page"):
                page = await browser_session.get_current_page()
            elif hasattr(browser_session, "current_page"):
                page = browser_session.current_page
            elif hasattr(browser_session, "_context") and browser_session._context:
                ctx = browser_session._context
                if hasattr(ctx, "pages") and ctx.pages:
                    page = ctx.pages[-1]
        except Exception:
            pass

        if page is None:
            return None

        buf = await page.screenshot(type="jpeg", quality=45, full_page=False, timeout=10000)
        b64 = base64.b64encode(buf).decode()
        # Re-compress if too large
        if len(b64) > 400_000:
            buf = await page.screenshot(type="jpeg", quality=25, full_page=False, timeout=10000)
            b64 = base64.b64encode(buf).decode()
        log_screenshot(task_id, b64, label, supabase)
        return b64
    except Exception as e:
        print(f"[Screenshot] Step {step} failed: {e}", flush=True)
        return None


# ── Main agent runner ──────────────────────────────────────────────────────────
async def run_browser_use_agent(
    task_id: str,
    prompt: str,
    cerebras_pool: Optional[CerebrasPool],
    cf_account_id: str,
    cf_api_key: str,
    cf_model: str,
    supabase=None,
    nopecha_key: str = "",
) -> dict:
    """Run the browser-use agent and stream logs + screenshots to Supabase."""

    if not BROWSER_USE_OK:
        return {"success": False, "summary": "browser-use library not installed", "steps": 0}

    # ── Pick LLM ──────────────────────────────────────────────────────────────
    llm = None
    llm_label = ""

    if cerebras_pool and LANGCHAIN_OK:
        key = cerebras_pool.next_key()
        if key:
            # Try models in priority order — llama-3.3-70b FIRST (proper tool-call support)
            for model in CEREBRAS_MODELS:
                try:
                    candidate = ChatOpenAI(
                        base_url=CEREBRAS_BASE,
                        api_key=key,
                        model=model,
                        temperature=0.0,
                        max_tokens=8192,
                        timeout=120,
                        max_retries=2,
                    )
                    # No pre-flight invoke — just trust the model and let browser-use handle failures.
                    # The invoke test doesn't check structured-output compatibility and wastes time.
                    llm = candidate
                    llm_label = f"Cerebras {model}"
                    log(task_id, f"⚡ Cerebras LLM ready: {model}", "info", supabase)
                    break
                except Exception as e:
                    print(f"[Cerebras] {model} init failed: {e}", flush=True)
                    continue

    if llm is None and cf_account_id and cf_api_key and LANGCHAIN_OK:
        try:
            candidate = make_cloudflare_llm(cf_account_id, cf_api_key, cf_model)
            if candidate:
                llm = candidate
                llm_label = f"Cloudflare {cf_model}"
                log(task_id, f"☁️ Cloudflare LLM ready: {cf_model}", "info", supabase)
        except Exception as e:
            print(f"[Cloudflare] LLM setup error: {e}", flush=True)

    if llm is None:
        msg = "No AI provider available — add Cerebras or Cloudflare keys in Settings"
        log(task_id, f"✗ {msg}", "error", supabase)
        return {"success": False, "summary": msg, "steps": 0}

    log(task_id, f"🤖 AI Engine: {llm_label}", "info", supabase)
    log(task_id, f"📋 Task: {prompt[:150]}{'…' if len(prompt) > 150 else ''}", "info", supabase)

    # ── Browser config ─────────────────────────────────────────────────────────
    browser_config = BrowserConfig(
        headless=True,
        disable_security=False,
        extra_chromium_args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1366,768",
            "--disable-infobars",
            "--no-first-run",
            "--disable-extensions",
        ],
    )

    browser = Browser(config=browser_config)

    # ── Step tracking ──────────────────────────────────────────────────────────
    step_count     = [0]
    browser_holder = [None]  # capture browser session reference for screenshots

    async def on_step_start(state: Any, output: Any, step_num: int):
        step_count[0] = step_num
        try:
            current_url = ""
            if hasattr(state, "url"):
                current_url = state.url[:80]
            elif hasattr(state, "tabs") and state.tabs:
                current_url = str(state.tabs[-1])[:80]

            action_desc = ""
            if output and hasattr(output, "current_state"):
                cs = output.current_state
                if hasattr(cs, "next_goal"):
                    action_desc = str(cs.next_goal)[:120]
                elif hasattr(cs, "evaluation_previous_goal"):
                    action_desc = str(cs.evaluation_previous_goal)[:120]
            if not action_desc and output:
                action_desc = str(output)[:120]

            msg = f"⚙️ Step {step_num}" + (f" — {action_desc}" if action_desc else "") + (f" | {current_url}" if current_url else "")
            log(task_id, msg, "info", supabase)
        except Exception as e:
            log(task_id, f"⚙️ Step {step_num}", "info", supabase)

    async def on_step_end(state: Any, output: Any, step_num: int):
        """Called after each step — capture screenshot every N steps."""
        try:
            if step_num % SCREENSHOT_EVERY == 0 or step_num == 1:
                # Try to get screenshot from browser state
                screenshot_b64 = None

                # browser-use may provide screenshot in state directly
                if hasattr(state, "screenshot") and state.screenshot:
                    screenshot_b64 = state.screenshot
                    size_kb = len(screenshot_b64) // 1024
                    print(f"[Screenshot] Got from state ({size_kb}KB)", flush=True)
                    log_screenshot(task_id, screenshot_b64, f"Step {step_num}", supabase)
                else:
                    # Fallback: capture directly from the browser session
                    session = browser_holder[0]
                    if session:
                        await take_page_screenshot(session, task_id, step_num, f"Step {step_num}", supabase)

                # Log action details
                if output:
                    try:
                        actions = []
                        if hasattr(output, "action"):
                            acts = output.action if isinstance(output.action, list) else [output.action]
                            for act in acts:
                                if act:
                                    actions.append(str(act)[:100])
                        if actions:
                            log(task_id, f"🔧 Actions: {' | '.join(actions[:3])}", "info", supabase)
                    except Exception:
                        pass
        except Exception as e:
            print(f"[StepEnd] {e}", flush=True)

    # ── Run agent ──────────────────────────────────────────────────────────────
    try:
        log(task_id, "🚀 Launching browser-use agent…", "info", supabase)

        async def combined_step_cb(state: Any, output: Any, step_num: int):
            await on_step_start(state, output, step_num)
            await on_step_end(state, output, step_num)

        agent = Agent(
            task=prompt,
            llm=llm,
            browser=browser,
            register_new_step_callback=combined_step_cb,
            register_done_callback=None,
            max_failures=3,
            retry_delay=3,
        )

        # Capture browser session reference for screenshots
        if hasattr(agent, "browser") and agent.browser:
            browser_holder[0] = agent.browser
        elif hasattr(agent, "_browser"):
            browser_holder[0] = agent._browser

        # Run with a generous step limit
        history = await agent.run(max_steps=50)

        # ── Extract result ─────────────────────────────────────────────────────
        success = True
        summary = ""

        if history:
            try:
                # browser-use AgentHistoryList has various result accessors
                if hasattr(history, "final_result"):
                    result_val = history.final_result()
                    if result_val:
                        summary = str(result_val)
                if not summary and hasattr(history, "extracted_content"):
                    content = history.extracted_content()
                    if content:
                        summary = "\n".join(str(c) for c in content if c)
                if not summary:
                    summary = str(history)[:1000]
            except Exception as he:
                summary = f"Task completed in {step_count[0]} steps. History parse error: {he}"
        else:
            summary = f"Task completed in {step_count[0]} steps."

        # Check for errors in history
        try:
            if history and hasattr(history, "has_errors") and history.has_errors():
                errors = history.errors() if hasattr(history, "errors") else []
                if errors:
                    log(task_id, f"⚠️ Agent encountered {len(errors)} error(s) during execution", "warning", supabase)
        except Exception:
            pass

        log(task_id, f"✅ Task complete!\n{summary[:600]}", "success", supabase)

        # Final screenshot
        session = browser_holder[0]
        if session:
            await take_page_screenshot(session, task_id, step_count[0], "Final state", supabase)

        return {
            "success": success,
            "summary": summary[:2000],
            "steps":   step_count[0],
        }

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[Agent] Fatal error:\n{tb}", flush=True)
        log(task_id, f"✗ Agent error: {str(e)[:300]}", "error", supabase)
        return {
            "success": False,
            "summary": f"Agent error: {str(e)[:500]}",
            "steps":   step_count[0],
        }
    finally:
        try:
            await browser.close()
        except Exception:
            pass


# ── Task Runner ────────────────────────────────────────────────────────────────
async def run_task(task_id: str):
    supabase = None
    if SUPABASE_AVAILABLE and SUPABASE_URL and SUPABASE_SVC_KEY:
        try:
            supabase = create_client(SUPABASE_URL, SUPABASE_SVC_KEY)
            print(f"[Supabase] Connected", flush=True)
        except Exception as e:
            print(f"[Supabase] Connection failed: {e}", flush=True)
    else:
        print(f"[WARN] Supabase not configured — no real-time logging", flush=True)

    # ── Fetch task ─────────────────────────────────────────────────────────────
    task = None
    if supabase:
        try:
            res = supabase.table("tasks").select("*").eq("id", task_id).single().execute()
            task = res.data
        except Exception as e:
            print(f"[ERROR] Fetch task: {e}", flush=True)

    if not task:
        print(f"[ERROR] Task {task_id} not found in Supabase", flush=True)
        return

    prompt  = task.get("prompt", "")
    user_id = task.get("user_id", "")

    if not prompt:
        log(task_id, "✗ Task has no prompt", "error", supabase)
        update_task_status(task_id, "failed",
            {"success": False, "summary": "Task has no prompt", "completedAt": datetime.utcnow().isoformat()},
            supabase)
        return

    # Mark running immediately
    update_task_status(task_id, "running", None, supabase)
    log(task_id, "🚀 AutoAgent Pro starting — browser-use engine", "info", supabase)

    # ── Load user settings ─────────────────────────────────────────────────────
    cerebras_keys: List[str] = []
    cf_account_id = CF_ACCOUNT_ID_ENV
    cf_api_key    = CF_API_KEY_ENV
    cf_model      = CF_MODEL_ENV or "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    nopecha_key   = NOPECHA_KEY

    if supabase and user_id:
        try:
            s_res = supabase.table("settings").select("*").eq("user_id", user_id).single().execute()
            settings = s_res.data
            if settings:
                cerebras_keys = settings.get("cerebras_keys") or []

                # Parse Cloudflare credentials (new multi-account JSON format)
                raw_cf_keys = settings.get("cloudflare_keys") or []
                legacy_acct = settings.get("cloudflare_account_id", "") or cf_account_id
                for item in raw_cf_keys:
                    item = (item or "").strip()
                    if not item:
                        continue
                    try:
                        obj = json.loads(item)
                        if isinstance(obj, dict) and obj.get("api_key"):
                            if obj.get("enabled", True):
                                cf_account_id = obj.get("account_id") or legacy_acct
                                cf_api_key    = obj["api_key"]
                                cf_model      = obj.get("model") or cf_model
                                log(task_id, f"☁️ Using Cloudflare cred: {obj.get('label','')}", "info", supabase)
                                break
                    except Exception:
                        # Legacy plain key
                        if legacy_acct and item:
                            cf_account_id = legacy_acct
                            cf_api_key    = item
                            break

                nopecha_key   = settings.get("nopecha_key") or nopecha_key
                if settings.get("cloudflare_model"):
                    cf_model = settings["cloudflare_model"]

                log(task_id, f"⚡ Cerebras keys: {len(cerebras_keys)} | ☁️ CF: {'yes' if cf_account_id and cf_api_key else 'no'}", "info", supabase)
        except Exception as e:
            print(f"[WARN] Settings load: {e}", flush=True)

    # Fall back to env vars if no user keys
    if not cerebras_keys:
        env_keys = os.environ.get("CEREBRAS_API_KEYS", "")
        if env_keys:
            cerebras_keys = [k.strip() for k in env_keys.split(",") if k.strip()]
            if cerebras_keys:
                log(task_id, f"⚡ Using env Cerebras keys ({len(cerebras_keys)})", "info", supabase)

    if not cerebras_keys and not (cf_account_id and cf_api_key):
        msg = "No AI keys configured. Add Cerebras or Cloudflare API keys in Settings."
        log(task_id, f"✗ {msg}", "error", supabase)
        update_task_status(task_id, "failed",
            {"success": False, "summary": msg, "completedAt": datetime.utcnow().isoformat()},
            supabase)
        return

    cerebras_pool = CerebrasPool(cerebras_keys) if cerebras_keys else None

    # ── Run agent ──────────────────────────────────────────────────────────────
    try:
        result = await run_browser_use_agent(
            task_id=task_id,
            prompt=prompt,
            cerebras_pool=cerebras_pool,
            cf_account_id=cf_account_id,
            cf_api_key=cf_api_key,
            cf_model=cf_model,
            supabase=supabase,
            nopecha_key=nopecha_key,
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[Task] Fatal:\n{tb}", flush=True)
        result = {"success": False, "summary": f"Fatal error: {str(e)[:300]}", "steps": 0}

    # ── Store result ───────────────────────────────────────────────────────────
    final_status = "completed" if result.get("success") else "failed"
    update_task_status(
        task_id,
        final_status,
        {
            "success":     result.get("success"),
            "summary":     result.get("summary", "")[:2000],
            "stepCount":   result.get("steps", 0),
            "completedAt": datetime.utcnow().isoformat(),
        },
        supabase,
    )

    log_type = "success" if result.get("success") else "error"
    log(task_id, f"{'✅ Completed' if result['success'] else '✗ Failed'}: {result.get('summary','')[:400]}", log_type, supabase)
    print(f"\n[Task] {task_id} → {final_status} ({result.get('steps',0)} steps)", flush=True)


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python browser_use_worker.py <task_id>", flush=True)
        sys.exit(1)

    task_id = sys.argv[1].strip()
    print(f"\n{'='*60}", flush=True)
    print(f"[AutoAgent Pro] browser-use worker v5", flush=True)
    print(f"[AutoAgent Pro] Task ID: {task_id}", flush=True)
    print(f"{'='*60}\n", flush=True)

    if not BROWSER_USE_OK:
        print("[FATAL] browser-use library not available. Install with:", flush=True)
        print("  pip install browser-use langchain-openai langchain", flush=True)
        sys.exit(1)

    asyncio.run(run_task(task_id))
