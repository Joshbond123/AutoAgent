#!/usr/bin/env python3
"""
AutoAgent Pro — Browser-Use Worker v9
==============================================
Primary LLM  : browser-use native ChatOpenAI → Cerebras endpoint (0.12.x)
               Falls back to LangChain ChatCerebras / ChatOpenAI for 0.1.x
Fallback LLM : Cloudflare Workers AI text model (custom BaseChatModel wrapper)
Browser      : browser-use (Playwright, headless) — version-agnostic setup
Screenshots  : Streamed to Supabase task_logs in real-time

API compatibility matrix:
  browser-use 0.12.x : browser-use own ChatOpenAI(base_url=CEREBRAS)  ← preferred
  browser-use 0.1.x  : LangChain ChatCerebras / ChatOpenAI wrappers
  Fallback            : Agent without explicit browser (agent creates its own)

Integration references:
  https://inference-docs.cerebras.ai/integrations/browser-use
  https://inference-docs.cerebras.ai/capabilities/tool-use
  https://docs.browser-use.com/open-source/supported-models
"""

import asyncio, os, sys, json, base64, re, traceback
from datetime import datetime
from typing import Optional, List, Any
import urllib.request as _ur

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────
CEREBRAS_BASE    = "https://api.cerebras.ai/v1"
SCREENSHOT_EVERY = 2  # capture a screenshot every N agent steps

# Model priority — Cerebras model IDs use no dash between "llama" and version
CEREBRAS_MODELS = [
    "llama3.3-70b",
    "llama3.1-8b",
]

# ─────────────────────────────────────────────────────────────────────────────
# Environment
# ─────────────────────────────────────────────────────────────────────────────
SUPABASE_URL      = os.environ.get("SUPABASE_URL", "")
SUPABASE_SVC_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
NOPECHA_KEY       = os.environ.get("NOPECHA_API_KEY", "")
CF_ACCOUNT_ID_ENV = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CF_API_KEY_ENV    = os.environ.get("CLOUDFLARE_API_KEY", "")
CF_MODEL_ENV      = os.environ.get("CLOUDFLARE_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")

# ─────────────────────────────────────────────────────────────────────────────
# Optional dependency imports
# ─────────────────────────────────────────────────────────────────────────────
try:
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("[WARN] supabase-py not installed — logs go to stdout only", flush=True)

# browser-use import (version-agnostic)
# Important: in 0.12.x+ Browser/BrowserConfig may be exported as None
# (backward-compat placeholders) — we must check callable() after import.
BROWSER_USE_OK       = False
Agent                = None
Browser              = None
BrowserConfig        = None
BrowserContextConfig = None

try:
    from browser_use import Agent
    # ── Browser / BrowserConfig (old API 0.1.x-0.2.x) ──
    # Try top-level first, then submodule; guard against None placeholders.
    for _bu_path in (
        ("browser_use",                "Browser", "BrowserConfig"),
        ("browser_use.browser.browser","Browser", "BrowserConfig"),
        ("browser_use.browser",        "Browser", "BrowserConfig"),
    ):
        try:
            import importlib as _il
            _m = _il.import_module(_bu_path[0])
            _B  = getattr(_m, _bu_path[1], None)
            _BC = getattr(_m, _bu_path[2], None)
            if callable(_B) and callable(_BC):
                Browser       = _B
                BrowserConfig = _BC
                print(f"[OK] Browser/BrowserConfig from {_bu_path[0]}", flush=True)
                break
        except Exception:
            pass
    if Browser is None:
        print("[INFO] Browser/BrowserConfig not found — will use BrowserSession or Agent-only mode", flush=True)

    # ── BrowserContextConfig (optional, some 0.1.x versions) ──
    for _ctx_path in (
        "browser_use.browser.context",
        "browser_use.browser",
        "browser_use",
    ):
        try:
            _cm = _il.import_module(_ctx_path)
            _BCC = getattr(_cm, "BrowserContextConfig", None)
            if callable(_BCC):
                BrowserContextConfig = _BCC
                break
        except Exception:
            pass

    BROWSER_USE_OK = True
    print(f"[OK] browser-use imported — Agent={Agent is not None}, "
          f"Browser={Browser is not None}, BrowserConfig={BrowserConfig is not None}", flush=True)
except ImportError as _e:
    print(f"[ERROR] browser-use not installed: {_e}", flush=True)

# browser-use native ChatOpenAI (0.12.x) — OpenAI client wrapper browser-use ships itself.
# Cerebras is OpenAI-compatible, so we can point it at CEREBRAS_BASE.
# This is Strategy 0 and avoids ALL LangChain/Pydantic compatibility issues with 0.12.x.
BU_NATIVE_CHAT_OK = False
BUChatOpenAI      = None
try:
    from browser_use.llm.openai.chat import ChatOpenAI as BUChatOpenAI
    BU_NATIVE_CHAT_OK = True
    print("[OK] browser-use native ChatOpenAI imported", flush=True)
except ImportError:
    print("[INFO] browser-use native ChatOpenAI not available (pre-0.12 API)", flush=True)

# LangChain OpenAI — required for Cerebras OpenAI-compat integration (0.1.x fallback)
LANGCHAIN_OK = False
ChatOpenAI   = None
try:
    from langchain_openai import ChatOpenAI
    LANGCHAIN_OK = True
    print("[OK] langchain-openai imported", flush=True)
except ImportError:
    print("[WARN] langchain-openai not installed", flush=True)

# LangChain Cerebras native (optional — 0.1.x fallback)
CEREBRAS_LANGCHAIN_OK = False
ChatCerebras          = None
try:
    from langchain_cerebras import ChatCerebras
    CEREBRAS_LANGCHAIN_OK = True
    print("[OK] langchain-cerebras imported", flush=True)
except ImportError:
    print("[WARN] langchain-cerebras not installed — using ChatOpenAI compat mode", flush=True)

# LangChain core helpers
LANGCHAIN_CORE_OK = False
try:
    from langchain_core.runnables import RunnableLambda
    from langchain_core.messages import SystemMessage, AIMessage, BaseMessage
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    import pydantic as _pydantic
    LANGCHAIN_CORE_OK = True
except ImportError as e:
    print(f"[WARN] langchain-core not available: {e}", flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# JSON extraction utility
# ─────────────────────────────────────────────────────────────────────────────
def _extract_json(text: str) -> str:
    """
    Robustly extract a JSON object from an LLM response.
    Handles: markdown fences, surrounding prose, nested objects.
    """
    text = text.strip()

    # Strip markdown fences first
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if fenced:
        candidate = fenced.group(1).strip()
        if candidate.startswith("{"):
            return candidate

    # Find outermost { ... } using a state machine (handles nested objects)
    start = text.find("{")
    if start == -1:
        return text

    depth  = 0
    in_str = False
    esc    = False
    for i, ch in enumerate(text[start:], start):
        if esc:
            esc = False
            continue
        if ch == "\\" and in_str:
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    return text[start:]  # unbalanced — best effort


# ─────────────────────────────────────────────────────────────────────────────
# Structured-output override factory
# ─────────────────────────────────────────────────────────────────────────────
def _make_wso_override():
    """
    Build a `with_structured_output` method suitable for any LangChain chat
    model subclass.

    browser-use calls:
        llm.with_structured_output(AgentOutput, include_raw=True)

    Cerebras models don't always produce the exact tool-call envelope that
    LangChain's default `with_structured_output` expects, which causes the
    agent to loop on Step 1 indefinitely.

    This replacement:
      1. Converts the Pydantic schema → JSON schema string
      2. Injects a strict formatting instruction into the system message
      3. Invokes the underlying LLM via ainvoke()
      4. Extracts and parses the JSON reply → Pydantic model
      5. Returns { "raw", "parsed", "parsing_error" } envelope (browser-use
         requires this shape when include_raw=True)
    """
    if not LANGCHAIN_CORE_OK:
        return None

    def with_structured_output(self_ref, schema, *, include_raw: bool = False, **kwargs):
        # Build JSON schema string
        try:
            if hasattr(schema, "model_json_schema"):
                json_schema_str = json.dumps(schema.model_json_schema(), indent=2)
            elif hasattr(schema, "schema"):
                json_schema_str = json.dumps(schema.schema(), indent=2)
            else:
                json_schema_str = str(schema)
        except Exception:
            json_schema_str = str(schema)

        FORMAT_INSTRUCTION = (
            "\n\n"
            "## CRITICAL OUTPUT FORMAT\n"
            "Your ENTIRE response MUST be a single valid JSON object.\n"
            "Do NOT include markdown fences, comments, or any text outside the JSON.\n"
            "Start with `{` and end with `}`. No prose before or after.\n"
            "Omit optional fields you don't need rather than setting them to null.\n"
            "The JSON must conform to this schema:\n"
            f"{json_schema_str}"
        )

        llm_ref = self_ref

        async def _invoke(messages):
            # Normalise input — browser-use passes list[BaseMessage] or PromptValue
            try:
                if hasattr(messages, "to_messages"):
                    msgs = list(messages.to_messages())
                elif isinstance(messages, (list, tuple)):
                    msgs = list(messages)
                else:
                    msgs = [messages]
            except Exception:
                msgs = list(messages) if messages else []

            # Inject format instruction into the system message
            new_msgs  = []
            injected  = False
            for m in msgs:
                if not injected and hasattr(m, "type") and m.type == "system":
                    content = m.content if isinstance(m.content, str) else str(m.content)
                    new_msgs.append(SystemMessage(content=content + FORMAT_INSTRUCTION))
                    injected = True
                else:
                    new_msgs.append(m)
            if not injected:
                new_msgs = [
                    SystemMessage(content="You are a browser automation AI agent." + FORMAT_INSTRUCTION)
                ] + msgs

            # Call the underlying LLM
            try:
                raw_response = await llm_ref.ainvoke(new_msgs)
            except Exception as e:
                print(f"[LLM] ainvoke error: {e!r}", flush=True)
                raw_response = AIMessage(content="{}")

            content = (
                raw_response.content
                if hasattr(raw_response, "content")
                else str(raw_response)
            )

            # Extract and parse JSON
            json_str      = _extract_json(content)
            parsed        = None
            parsing_error = None

            try:
                data = json.loads(json_str)
                if hasattr(_pydantic, "VERSION") and _pydantic.VERSION.startswith("2."):
                    parsed = schema.model_validate(data)
                else:
                    parsed = schema(**data)
            except Exception as e:
                parsing_error = str(e)
                print(
                    f"[LLM] JSON parse error: {e!r} | "
                    f"raw_len={len(content)} | "
                    f"extracted_start={json_str[:200]!r}",
                    flush=True,
                )

            if include_raw:
                return {"raw": raw_response, "parsed": parsed, "parsing_error": parsing_error}
            return parsed

        return RunnableLambda(_invoke)

    return with_structured_output


# ─────────────────────────────────────────────────────────────────────────────
# Cerebras LLM builder
# ─────────────────────────────────────────────────────────────────────────────
def make_cerebras_llm(api_key: str, model: str):
    """
    Build an LLM for Cerebras compatible with the installed browser-use version.

    Strategy order:
      0. browser-use native ChatOpenAI → Cerebras base_url  (0.12.x preferred)
         browser-use 0.12+ has its own LLM API (not LangChain). Its ChatOpenAI
         dataclass accepts base_url, so we can point it at Cerebras's OpenAI-
         compatible endpoint. This avoids all Pydantic/LangChain shim issues.
      1. langchain-cerebras ChatCerebras subclass (0.1.x fallback)
      2. langchain-openai ChatOpenAI subclass → Cerebras base_url (0.1.x fallback)
    """
    # ── Strategy 0: browser-use native ChatOpenAI → Cerebras ──────────────────
    if BU_NATIVE_CHAT_OK and BUChatOpenAI is not None:
        try:
            llm = BUChatOpenAI(
                model=model,
                api_key=api_key,
                base_url=CEREBRAS_BASE,
                temperature=0.0,
                max_completion_tokens=8192,
                # Cerebras rejects response_format schemas that include
                # minLength/maxLength on string fields (code: wrong_api_format).
                # dont_force_structured_output=True — browser-use won't use
                # response_format API parameter; relies on system prompt instead.
                # add_schema_to_system_prompt=False — keep system prompt compact;
                # llama3.1-8b has an 8192-token total context window and the
                # injected JSON schema tips it over (9355 > 8192 token error).
                # browser-use's existing system prompt already describes the
                # required JSON output format (AgentOutput schema).
                dont_force_structured_output=True,
                add_schema_to_system_prompt=False,
                remove_min_items_from_schema=True,
                remove_defaults_from_schema=True,
            )
            print(f"[Cerebras] browser-use native ChatOpenAI ready: {model}", flush=True)
            return llm
        except Exception as e:
            print(f"[Cerebras] BU native ChatOpenAI failed: {e} — trying LangChain", flush=True)

    # ── Strategies 1 & 2 require LangChain core ──────────────────────────────
    if not LANGCHAIN_CORE_OK:
        print("[Cerebras] langchain-core not available", flush=True)
        return None

    wso = _make_wso_override()
    if wso is None:
        return None

    # Strategy 1 — native langchain-cerebras
    if CEREBRAS_LANGCHAIN_OK and ChatCerebras is not None:
        try:
            class _CerebrasJSONMode(ChatCerebras):
                """ChatCerebras with JSON-mode structured output override.
                provider: browser-use 0.12+ checks llm.provider == 'browser-use'.
                __setattr__: browser-use 0.12+ monkey-patches ainvoke/acall on the
                  LLM instance (token cost service); Pydantic blocks this by default,
                  so we fall back to object.__setattr__ for unknown fields.
                """
                provider: str = "openai"

                def __setattr__(self, name: str, value) -> None:
                    try:
                        super().__setattr__(name, value)
                    except (ValueError, TypeError):
                        object.__setattr__(self, name, value)

                def with_structured_output(self, schema, *, include_raw=False, **kwargs):
                    return wso(self, schema, include_raw=include_raw, **kwargs)

            llm = _CerebrasJSONMode(
                api_key=api_key,
                model=model,
                temperature=0.0,
                max_tokens=8192,
            )
            print(f"[Cerebras] ChatCerebras (JSON-mode) ready: {model}", flush=True)
            return llm
        except Exception as e:
            print(f"[Cerebras] ChatCerebras init failed: {e} — trying OpenAI compat", flush=True)

    # Strategy 2 — OpenAI-compatible (official Cerebras docs approach)
    if LANGCHAIN_OK and ChatOpenAI is not None:
        try:
            class _CerebrasOpenAICompat(ChatOpenAI):
                """ChatOpenAI → Cerebras base_url with JSON-mode override.
                provider: required by browser-use 0.12+ Agent.__init__.
                __setattr__: allows browser-use token service monkey-patching.
                Ref: https://inference-docs.cerebras.ai/integrations/browser-use
                """
                provider: str = "openai"

                def __setattr__(self, name: str, value) -> None:
                    try:
                        super().__setattr__(name, value)
                    except (ValueError, TypeError):
                        object.__setattr__(self, name, value)

                def with_structured_output(self, schema, *, include_raw=False, **kwargs):
                    return wso(self, schema, include_raw=include_raw, **kwargs)

            llm = _CerebrasOpenAICompat(
                base_url=CEREBRAS_BASE,
                api_key=api_key,
                model=model,
                temperature=0.0,
                max_tokens=8192,
                timeout=120,
                max_retries=2,
            )
            print(f"[Cerebras] ChatOpenAI-compat (JSON-mode) ready: {model}", flush=True)
            return llm
        except Exception as e:
            print(f"[Cerebras] ChatOpenAI-compat init failed: {e}", flush=True)

    return None


# ─────────────────────────────────────────────────────────────────────────────
# Cloudflare LLM builder
# ─────────────────────────────────────────────────────────────────────────────
def _cf_text_sync(account_id: str, api_key: str, model: str, messages: list) -> str:
    """Synchronous Cloudflare Workers AI text call."""
    url  = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
    body = json.dumps({"messages": messages}).encode()
    req  = _ur.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type":  "application/json",
    })
    try:
        with _ur.urlopen(req, timeout=60) as r:
            data    = json.loads(r.read())
        result  = data.get("result", {}) or {}
        choices = result.get("choices") or []
        if choices:
            return choices[0].get("message", {}).get("content", "") or ""
        return result.get("response", "") or ""
    except Exception as e:
        print(f"[Cloudflare] text error: {e}", flush=True)
        return ""


def make_cloudflare_llm(account_id: str, api_key: str, model: str):
    """
    Wrap Cloudflare Workers AI as a LangChain BaseChatModel.
    Includes the JSON-mode structured output override so browser-use can use it.
    """
    if not LANGCHAIN_CORE_OK:
        return None

    wso = _make_wso_override()
    if wso is None:
        return None

    try:
        class CloudflareChatModel(BaseChatModel):
            account_id: str
            api_key: str
            model: str
            # browser-use 0.12+ checks llm.provider — must not be 'browser-use'
            provider: str = "openai"

            def __setattr__(self, name: str, value) -> None:
                try:
                    super().__setattr__(name, value)
                except (ValueError, TypeError):
                    object.__setattr__(self, name, value)

            @property
            def _llm_type(self) -> str:
                return "cloudflare"

            def _generate(
                self,
                messages: List[BaseMessage],
                stop=None,
                run_manager=None,
                **kwargs,
            ) -> "ChatResult":
                lc_msgs = []
                for m in messages:
                    mtype = getattr(m, "type", "human")
                    role  = (
                        "system"    if mtype == "system"
                        else "user" if mtype == "human"
                        else "assistant"
                    )
                    lc_msgs.append({"role": role, "content": str(m.content)})

                reply = _cf_text_sync(self.account_id, self.api_key, self.model, lc_msgs)
                gen   = ChatGeneration(
                    message=AIMessage(content=reply or "Unable to process this request.")
                )
                return ChatResult(generations=[gen])

            def with_structured_output(self, schema, *, include_raw=False, **kwargs):
                return wso(self, schema, include_raw=include_raw, **kwargs)

        llm = CloudflareChatModel(account_id=account_id, api_key=api_key, model=model)
        print(f"[Cloudflare] LLM ready: {model}", flush=True)
        return llm
    except Exception as e:
        print(f"[Cloudflare] LLM wrapper error: {e}", flush=True)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# LLM probe — verify the model actually works before handing to the agent.
# browser-use native ChatOpenAI (and LangChain) create client objects without
# making any API calls, so a model_not_found 404 only surfaces during agent
# execution.  Probing here lets us fall through to the next model in the list.
# ─────────────────────────────────────────────────────────────────────────────
async def probe_llm(llm) -> bool:
    """
    Make a tiny test call to confirm the model exists and the key is valid.
    Returns True if the call succeeds (or fails for a non-model reason),
    False if the response is a 404 model-not-found or auth error.
    """
    try:
        if BU_NATIVE_CHAT_OK and BUChatOpenAI is not None and isinstance(llm, BUChatOpenAI):
            from browser_use.llm.messages import UserMessage as _BUMsg
            resp = await llm.ainvoke([_BUMsg(content="Say OK in 2 words.")], output_format=None)
            print(f"[LLM Probe] OK — model={llm.model}", flush=True)
            return True
    except Exception as e:
        err = str(e)
        if any(x in err for x in ("404", "not_found_error", "does not exist", "401", "403", "Unauthorized")):
            print(f"[LLM Probe] Model/auth failed ({llm.model if hasattr(llm, 'model') else '?'}): {err[:200]}", flush=True)
            return False
        # Unknown error — let the agent try anyway (may be transient)
        print(f"[LLM Probe] Non-fatal error: {err[:200]}", flush=True)
    return True  # LangChain or unrecognised LLM — assume ok


# ─────────────────────────────────────────────────────────────────────────────
# Cerebras key pool
# ─────────────────────────────────────────────────────────────────────────────
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
        key      = avail[self.idx % len(avail)]
        self.idx = (self.idx + 1) % max(len(avail), 1)
        return key

    def mark_failed(self, key: str):
        self.failed.add(key)

    @property
    def size(self):
        return len(self.keys)


# ─────────────────────────────────────────────────────────────────────────────
# Supabase logging helpers
# ─────────────────────────────────────────────────────────────────────────────
def log(task_id: str, message: str, log_type: str = "info", supabase=None):
    icons = {
        "info": "ℹ", "success": "✓", "error": "✗",
        "warning": "⚠", "screenshot": "📸",
    }
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
    """
    Store a base64 screenshot in task_logs via direct REST call.
    (supabase-py has size limits that prevent storing large payloads inline.)
    """
    if not b64:
        return
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
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {SUPABASE_SVC_KEY}",
                "apikey":        SUPABASE_SVC_KEY,
                "Content-Type":  "application/json",
                "Prefer":        "return=minimal",
            },
        )
        with _ur.urlopen(req, timeout=25) as r:
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


# ─────────────────────────────────────────────────────────────────────────────
# Screenshot capture helper
# ─────────────────────────────────────────────────────────────────────────────
async def capture_screenshot(
    browser_obj, task_id: str, step: int, label: str, supabase=None
) -> Optional[str]:
    """
    Capture a JPEG screenshot from the active browser page.
    Tries multiple browser-use API shapes (version-agnostic).
    """
    try:
        page = None

        # browser-use ≥ 0.1.40: BrowserSession.get_current_page()
        if hasattr(browser_obj, "get_current_page"):
            try:
                page = await browser_obj.get_current_page()
            except Exception:
                pass

        # Some versions expose .current_page directly
        if page is None and hasattr(browser_obj, "current_page"):
            page = browser_obj.current_page

        # Fallback: dig into the playwright context
        if page is None:
            for attr in ("_context", "context", "_browser_context"):
                ctx = getattr(browser_obj, attr, None)
                if ctx and hasattr(ctx, "pages") and ctx.pages:
                    page = ctx.pages[-1]
                    break

        if page is None:
            return None

        buf = await page.screenshot(type="jpeg", quality=50, full_page=False, timeout=15000)
        b64 = base64.b64encode(buf).decode()

        # Re-compress if too large (> 350 KB base64 ≈ ~262 KB binary)
        if len(b64) > 350_000:
            buf = await page.screenshot(type="jpeg", quality=25, full_page=False, timeout=15000)
            b64 = base64.b64encode(buf).decode()

        log_screenshot(task_id, b64, label, supabase)
        return b64

    except Exception as e:
        print(f"[Screenshot] Step {step} failed: {e}", flush=True)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Main agent runner
# ─────────────────────────────────────────────────────────────────────────────
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
    """
    Run the browser-use agent and stream logs + screenshots to Supabase.

    LLM selection order:
      1. Cerebras  (llama-3.3-70b → llama3.1-8b)  via JSON-mode wrapper
      2. Cloudflare Workers AI text model            via JSON-mode wrapper
    """

    if not BROWSER_USE_OK:
        return {"success": False, "summary": "browser-use library not installed", "steps": 0}

    # ── LLM selection ─────────────────────────────────────────────────────────
    llm       = None
    llm_label = ""
    used_key  = None

    if cerebras_pool and cerebras_pool.size > 0 and (BU_NATIVE_CHAT_OK or CEREBRAS_LANGCHAIN_OK or LANGCHAIN_OK):
        key = cerebras_pool.next_key()
        if key:
            used_key = key
            for model in CEREBRAS_MODELS:
                try:
                    candidate = make_cerebras_llm(api_key=key, model=model)
                    if candidate is not None:
                        # Probe: verify model exists before committing
                        if not await probe_llm(candidate):
                            log(task_id, f"⚠️ Cerebras {model} unavailable — trying next model", "warning", supabase)
                            continue
                        llm       = candidate
                        llm_label = f"Cerebras/{model}"
                        log(task_id, f"⚡ Using Cerebras LLM: {model}", "info", supabase)
                        break
                except Exception as e:
                    print(f"[Cerebras] {model} init error: {e}", flush=True)

    if llm is None and cf_account_id and cf_api_key:
        try:
            candidate = make_cloudflare_llm(cf_account_id, cf_api_key, cf_model)
            if candidate:
                llm       = candidate
                llm_label = f"Cloudflare/{cf_model.split('/')[-1]}"
                log(task_id, f"☁️ Using Cloudflare LLM: {cf_model}", "info", supabase)
        except Exception as e:
            print(f"[Cloudflare] LLM setup error: {e}", flush=True)

    if llm is None:
        msg = "No AI provider available — add Cerebras or Cloudflare API keys in Settings"
        log(task_id, f"✗ {msg}", "error", supabase)
        return {"success": False, "summary": msg, "steps": 0}

    log(task_id, f"🤖 AI Engine: {llm_label}", "info", supabase)
    log(task_id, f"📋 Task: {prompt[:200]}{'…' if len(prompt) > 200 else ''}", "info", supabase)

    # ── Browser setup (version-agnostic) ──────────────────────────────────────
    # Headless env vars respected by browser-use 0.11+ and Playwright
    os.environ.setdefault("BROWSER_HEADLESS", "true")
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")

    chromium_args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1366,768",
        "--disable-infobars",
        "--no-first-run",
        "--disable-extensions",
        "--disable-background-networking",
        "--hide-scrollbars",
        "--mute-audio",
    ]

    browser_obj = None  # Will be passed to Agent as browser= or browser_session=

    # Strategy A: browser-use 0.1.x / 0.2.x ─ Browser(config=BrowserConfig(...))
    if Browser is not None and BrowserConfig is not None:
        try:
            cfg_kw: dict = dict(
                headless=True,
                disable_security=False,
                extra_chromium_args=chromium_args,
            )
            # Optional context config
            if BrowserContextConfig is not None:
                try:
                    cfg_kw["new_context_config"] = BrowserContextConfig(
                        wait_for_network_idle_page_load_time=2.0,
                        browser_window_size={"width": 1366, "height": 768},
                    )
                except Exception:
                    pass
            # Drop unknown kwargs one by one until constructor accepts them
            drop_sequence = [None, "new_context_config", "disable_security", "extra_chromium_args"]
            for drop in drop_sequence:
                if drop:
                    cfg_kw.pop(drop, None)
                try:
                    browser_obj = Browser(config=BrowserConfig(**cfg_kw))
                    print(f"[Browser] Old API ready (Browser/BrowserConfig)", flush=True)
                    break
                except TypeError:
                    continue
        except Exception as e:
            print(f"[Browser] Old API failed: {e}", flush=True)
            browser_obj = None

    # Strategy B: browser-use 0.11+ ─ BrowserSession / BrowserProfile
    if browser_obj is None:
        import importlib
        for session_mod, profile_mod in [
            ("browser_use.browser.browser", "browser_use.browser.profile"),
            ("browser_use.browser",         "browser_use.browser"),
            ("browser_use",                 "browser_use"),
        ]:
            try:
                smod = importlib.import_module(session_mod)
                _BrowserSession = getattr(smod, "BrowserSession", None)
                if _BrowserSession is None:
                    continue
                # Try to build a profile with chromium args
                pmod = importlib.import_module(profile_mod)
                _BrowserProfile = (
                    getattr(pmod, "BrowserProfile", None)
                    or getattr(pmod, "DefaultBrowserProfile", None)
                )
                session_built = False
                if _BrowserProfile is not None:
                    for profile_kw in [
                        dict(headless=True, extra_chromium_args=chromium_args),
                        dict(headless=True),
                        {},
                    ]:
                        try:
                            _prof = _BrowserProfile(**profile_kw)
                            browser_obj = _BrowserSession(browser_profile=_prof)
                            session_built = True
                            break
                        except Exception:
                            continue
                if not session_built:
                    for session_kw in [dict(headless=True), {}]:
                        try:
                            browser_obj = _BrowserSession(**session_kw)
                            session_built = True
                            break
                        except Exception:
                            continue
                if session_built and browser_obj is not None:
                    print(f"[Browser] New API ready (BrowserSession from {session_mod})", flush=True)
                    break
            except Exception:
                continue

    if browser_obj is None:
        print("[Browser] No explicit browser object — Agent will create its own", flush=True)

    # ── Step tracking ──────────────────────────────────────────────────────────
    step_count     = [0]
    browser_holder = [None]  # holds browser reference for screenshot capture

    async def on_step(state: Any, output: Any, step_num: int):
        """
        Called by browser-use after each agent step.
        Logs goal/action details and captures periodic screenshots.

        Supports both browser-use 0.1.x and 0.2.x callback signatures.
        """
        step_count[0] = step_num

        # Extract current URL
        current_url = ""
        for attr in ("url", "current_url"):
            val = getattr(state, attr, None)
            if val:
                current_url = str(val)[:100]
                break
        if not current_url and hasattr(state, "tabs") and state.tabs:
            try:
                current_url = str(state.tabs[-1])[:100]
            except Exception:
                pass

        # Extract goal / action description
        goal = ""
        if output is not None:
            for path in (
                ("current_state", "next_goal"),
                ("current_state", "memory"),
                ("current_state", "evaluation_previous_goal"),
            ):
                try:
                    val = output
                    for attr in path:
                        val = getattr(val, attr, None)
                        if val is None:
                            break
                    if val:
                        goal = str(val)[:150]
                        break
                except Exception:
                    pass

            if not goal:
                try:
                    goal = str(output)[:150]
                except Exception:
                    pass

        msg = f"⚙️ Step {step_num}"
        if goal:
            msg += f" — {goal}"
        if current_url:
            msg += f"\n   🌐 {current_url}"
        log(task_id, msg, "info", supabase)

        # Log action names
        if output is not None:
            try:
                actions = getattr(output, "action", None)
                if actions is not None:
                    acts  = actions if isinstance(actions, list) else [actions]
                    descs = [str(a)[:100] for a in acts[:3] if a is not None]
                    if descs:
                        log(task_id, f"🔧 Actions: {' | '.join(descs)}", "info", supabase)
            except Exception:
                pass

        # Periodic screenshot
        if step_num % SCREENSHOT_EVERY == 0 or step_num == 1:
            # Check if state carries a screenshot already
            ss_b64 = getattr(state, "screenshot", None)
            if ss_b64:
                log_screenshot(task_id, ss_b64, f"Step {step_num}", supabase)
            else:
                session = browser_holder[0]
                if session:
                    await capture_screenshot(
                        session, task_id, step_num, f"Step {step_num}", supabase
                    )

    # ── Create and run the Agent ───────────────────────────────────────────────
    history = None
    try:
        log(task_id, "🚀 Launching browser-use agent…", "info", supabase)

        # ── Introspect Agent.__init__ to build valid kwargs ───────────────────
        import inspect as _inspect
        try:
            _agent_params = set(_inspect.signature(Agent.__init__).parameters.keys())
        except Exception:
            _agent_params = set()  # unknown — try everything
        print(f"[Agent] Known params: {sorted(_agent_params)[:20]}", flush=True)

        def _agent_accepts(name: str) -> bool:
            return not _agent_params or name in _agent_params or "kwargs" in str(_agent_params)

        # Build base kwargs
        agent_base_kwargs: dict = dict(task=prompt, llm=llm)

        # max_failures / max_actions
        for mf_name in ("max_failures", "max_actions"):
            if _agent_accepts(mf_name):
                agent_base_kwargs[mf_name] = 5
                print(f"[Agent] Failures kwarg: {mf_name}", flush=True)
                break

        # Limit DOM elements sent per step to stay within Cerebras context window.
        # llama3.1-8b has 8192-token total limit; without capping DOM, the agent
        # easily sends 9000+ tokens per step.
        for elem_kwarg in ("max_clickable_elements_length",):
            if _agent_accepts(elem_kwarg):
                agent_base_kwargs[elem_kwarg] = 20
                print(f"[Agent] DOM cap kwarg: {elem_kwarg}=20", flush=True)
                break

        # browser= vs browser_session=
        # Prefer browser_session= for BrowserSession objects (new API 0.11+),
        # prefer browser= for old Browser objects.
        if browser_obj is not None:
            obj_cls_name = type(browser_obj).__name__
            kwarg_order = ("browser_session", "browser") if "Session" in obj_cls_name else ("browser", "browser_session")
            for br_name in kwarg_order:
                if _agent_accepts(br_name):
                    agent_base_kwargs[br_name] = browser_obj
                    print(f"[Agent] Browser kwarg: {br_name} (obj={obj_cls_name})", flush=True)
                    break
            else:
                print("[Agent] No browser kwarg in Agent params — agent creates own browser", flush=True)
        else:
            print("[Agent] No browser object — agent creates own browser", flush=True)

        agent_kwargs = dict(agent_base_kwargs)

        # ── Probe callback kwarg name ──────────────────────────────────────────
        agent = None
        for cb_kwarg in ("register_new_step_callback", "on_step_start", "step_callback"):
            if not _agent_accepts(cb_kwarg):
                continue
            try:
                test_kwargs = {**agent_kwargs, cb_kwarg: on_step}
                agent = Agent(**test_kwargs)
                agent_kwargs = test_kwargs
                print(f"[Agent] Using callback kwarg: {cb_kwarg}", flush=True)
                break
            except TypeError as _te:
                print(f"[Agent] {cb_kwarg} TypeError: {_te}", flush=True)
            except Exception as _ex:
                print(f"[Agent] {cb_kwarg} error: {_ex}", flush=True)

        if agent is None:
            # No callback support — run without it
            agent = Agent(**agent_kwargs)
            print("[Agent] Running without step callback", flush=True)

        # Capture browser reference for manual screenshots
        for attr in ("browser", "_browser", "browser_session", "_browser_session"):
            ref = getattr(agent, attr, None)
            if ref is not None:
                browser_holder[0] = ref
                break

        # Run the agent (generous step limit)
        history = await agent.run(max_steps=50)

        # Mark the Cerebras key as working
        if used_key and cerebras_pool:
            cerebras_pool.failed.discard(used_key)

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[Agent] Fatal error:\n{tb}", flush=True)
        if used_key and cerebras_pool and ("401" in str(e) or "403" in str(e)):
            cerebras_pool.mark_failed(used_key)
        log(task_id, f"✗ Agent error: {str(e)[:400]}", "error", supabase)
        try:
            await browser.close()
        except Exception:
            pass
        return {
            "success": False,
            "summary": f"Agent error: {str(e)[:600]}",
            "steps":   step_count[0],
        }

    # ── Extract result from history ────────────────────────────────────────────
    summary = ""
    success = True

    if history is not None:
        try:
            for method in ("final_result", "extracted_content", "last_action"):
                fn = getattr(history, method, None)
                if callable(fn):
                    try:
                        val = fn()
                        if val:
                            summary = (
                                "\n".join(str(v) for v in val if v)
                                if isinstance(val, (list, tuple))
                                else str(val)
                            )
                            break
                    except Exception:
                        pass

            if not summary:
                summary = str(history)[:1200]

        except Exception as he:
            summary = f"Task ran for {step_count[0]} steps (result parse error: {he})"

        # Check for errors in history
        try:
            if hasattr(history, "has_errors") and history.has_errors():
                errs      = getattr(history, "errors", lambda: [])()
                err_count = len(errs) if hasattr(errs, "__len__") else "some"
                log(task_id, f"⚠️ Agent encountered {err_count} error(s)", "warning", supabase)
        except Exception:
            pass
    else:
        summary = f"Task completed in {step_count[0]} steps."

    if not summary:
        summary = f"Task completed in {step_count[0]} steps."

    log(task_id, f"✅ Task complete!\n{summary[:800]}", "success", supabase)

    # Final screenshot
    session = browser_holder[0]
    if session:
        await capture_screenshot(session, task_id, step_count[0], "Final state", supabase)

    try:
        await browser.close()
    except Exception:
        pass

    return {"success": success, "summary": summary[:2000], "steps": step_count[0]}


# ─────────────────────────────────────────────────────────────────────────────
# Task runner
# ─────────────────────────────────────────────────────────────────────────────
async def run_task(task_id: str):
    """Fetch a task from Supabase and execute it via the browser-use agent."""

    supabase = None
    if SUPABASE_AVAILABLE and SUPABASE_URL and SUPABASE_SVC_KEY:
        try:
            supabase = create_client(SUPABASE_URL, SUPABASE_SVC_KEY)
            print(f"[Supabase] Connected", flush=True)
        except Exception as e:
            print(f"[Supabase] Connection failed: {e}", flush=True)
    else:
        print("[WARN] Supabase not configured — logs go to stdout only", flush=True)

    # Fetch task record
    task = None
    if supabase:
        try:
            res  = supabase.table("tasks").select("*").eq("id", task_id).single().execute()
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
            {"success": False, "summary": "Task has no prompt",
             "completedAt": datetime.utcnow().isoformat()},
            supabase)
        return

    update_task_status(task_id, "running", None, supabase)
    log(task_id, "🚀 AutoAgent Pro starting — browser-use engine v8", "info", supabase)

    # ── Load user settings from Supabase ──────────────────────────────────────
    cerebras_keys: List[str] = []
    cf_account_id = CF_ACCOUNT_ID_ENV
    cf_api_key    = CF_API_KEY_ENV
    cf_model      = CF_MODEL_ENV or "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    nopecha_key   = NOPECHA_KEY

    if supabase and user_id:
        try:
            s_res    = supabase.table("settings").select("*").eq("user_id", user_id).single().execute()
            settings = s_res.data or {}

            # Cerebras keys (array of plain key strings)
            raw_cerebras  = settings.get("cerebras_keys") or []
            cerebras_keys = [k.strip() for k in raw_cerebras if k and k.strip()]

            # Cloudflare credentials (new multi-account JSON format)
            raw_cf_keys = settings.get("cloudflare_keys") or []
            legacy_acct = settings.get("cloudflare_account_id", "") or cf_account_id

            for item in raw_cf_keys:
                item = (item or "").strip()
                if not item:
                    continue
                try:
                    obj = json.loads(item)
                    if isinstance(obj, dict) and obj.get("api_key") and obj.get("enabled", True):
                        cf_account_id = obj.get("account_id") or legacy_acct
                        cf_api_key    = obj["api_key"]
                        cf_model      = obj.get("model") or cf_model
                        log(task_id, f"☁️ Cloudflare credential: {obj.get('label', 'unnamed')}", "info", supabase)
                        break
                except Exception:
                    # Legacy plain key format
                    if legacy_acct and item:
                        cf_account_id = legacy_acct
                        cf_api_key    = item
                        break

            if settings.get("nopecha_key"):
                nopecha_key = settings["nopecha_key"]
            if settings.get("cloudflare_model"):
                cf_model = settings["cloudflare_model"]

            log(
                task_id,
                f"⚡ Cerebras keys loaded: {len(cerebras_keys)} | "
                f"☁️ Cloudflare: {'yes' if cf_account_id and cf_api_key else 'no'}",
                "info",
                supabase,
            )
        except Exception as e:
            print(f"[WARN] Settings load: {e}", flush=True)

    # Fall back to GitHub Actions env vars / secrets
    if not cerebras_keys:
        # Multi-key env var (comma-separated)
        env_keys = os.environ.get("CEREBRAS_API_KEYS", "")
        if env_keys:
            cerebras_keys = [k.strip() for k in env_keys.split(",") if k.strip()]
        # Single-key env var
        if not cerebras_keys:
            single = os.environ.get("CEREBRAS_API_KEY", "")
            if single.strip():
                cerebras_keys = [single.strip()]
        if cerebras_keys:
            log(task_id, f"⚡ Using env Cerebras keys ({len(cerebras_keys)})", "info", supabase)

    if not cf_account_id or not cf_api_key:
        env_cf_id  = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        env_cf_key = os.environ.get("CLOUDFLARE_API_KEY", "")
        if env_cf_id and env_cf_key:
            cf_account_id = env_cf_id
            cf_api_key    = env_cf_key

    if not cerebras_keys and not (cf_account_id and cf_api_key):
        msg = (
            "No AI API keys configured. "
            "Add Cerebras or Cloudflare API keys in Settings → AI Providers."
        )
        log(task_id, f"✗ {msg}", "error", supabase)
        update_task_status(task_id, "failed",
            {"success": False, "summary": msg,
             "completedAt": datetime.utcnow().isoformat()},
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
        result = {"success": False, "summary": f"Fatal error: {str(e)[:400]}", "steps": 0}

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
    log(
        task_id,
        f"{'✅ Completed' if result['success'] else '✗ Failed'}: {result.get('summary','')[:400]}",
        log_type,
        supabase,
    )
    print(f"\n[Task] {task_id} → {final_status} ({result.get('steps', 0)} steps)", flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python browser_use_worker.py <task_id>", flush=True)
        sys.exit(1)

    task_id = sys.argv[1].strip()
    print(f"\n{'=' * 60}", flush=True)
    print(f"[AutoAgent Pro] browser-use worker v8", flush=True)
    print(f"[AutoAgent Pro] Task ID: {task_id}", flush=True)
    print(f"{'=' * 60}\n", flush=True)

    if not BROWSER_USE_OK:
        print("[FATAL] browser-use library not available. Install with:", flush=True)
        print(
            "  pip install 'browser-use>=0.1.40' langchain-openai langchain-cerebras",
            flush=True,
        )
        sys.exit(1)

    asyncio.run(run_task(task_id))
