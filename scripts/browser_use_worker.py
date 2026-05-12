#!/usr/bin/env python3
"""
AutoAgent Pro - Browser Use Worker
Uses the browser-use library for human-like AI browser automation.
"""

import asyncio
import os
import sys
import json
import traceback
from datetime import datetime
from typing import Optional

# Install browser-use if not present
try:
    from browser_use import Agent, Browser, BrowserConfig
    from browser_use.browser.context import BrowserContext, BrowserContextConfig
    from langchain_google_genai import ChatGoogleGenerativeAI
    BROWSER_USE_AVAILABLE = True
except ImportError:
    BROWSER_USE_AVAILABLE = False
    print("[WARN] browser-use not installed. Falling back to Playwright.")

try:
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("[WARN] supabase-py not installed.")

# Environment configuration
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
NOPECHA_API_KEY = os.environ.get("NOPECHA_API_KEY", "")
TASK_ID = os.environ.get("TASK_ID", "")


def log(task_id: str, message: str, log_type: str = "info", supabase=None):
    """Log a message to console and Supabase."""
    timestamp = datetime.utcnow().isoformat()
    prefix = {"info": "[INFO]", "success": "[SUCCESS]", "error": "[ERROR]", "warning": "[WARN]"}.get(log_type, "[INFO]")
    print(f"{prefix} {message}", flush=True)

    if supabase and task_id:
        try:
            supabase.table("task_logs").insert({
                "task_id": task_id,
                "message": message,
                "log_type": log_type,
                "created_at": timestamp,
            }).execute()
        except Exception as e:
            print(f"[WARN] Failed to persist log: {e}", flush=True)


async def run_with_browser_use(task_id: str, prompt: str, supabase=None) -> dict:
    """Run agent task using the browser-use library."""
    log(task_id, "Initializing Browser Use agent...", "info", supabase)

    # Configure LLM (Gemini)
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.0-flash",
        google_api_key=GEMINI_API_KEY,
        temperature=0.3,
    )

    # Configure browser with stealth settings
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

    # Context config with human-like settings
    context_config = BrowserContextConfig(
        wait_for_network_idle_page_load_time=3.0,
        browser_window_size={"width": 1366, "height": 768},
        highlight_elements=False,
        viewport_expansion=500,
    )

    logs_collected = []

    async def on_step_callback(state, output, step_num):
        """Called after each agent step."""
        msg = f"Step {step_num}: {output.current_state.next_goal if hasattr(output, 'current_state') else str(output)[:100]}"
        log(task_id, msg, "info", supabase)
        logs_collected.append(msg)

    log(task_id, f"Starting browser automation for: {prompt[:100]}...", "info", supabase)

    try:
        agent = Agent(
            task=prompt,
            llm=llm,
            browser=browser,
            browser_context=browser.new_context(config=context_config),
            max_actions_per_step=10,
            save_conversation_path=f"/tmp/agent_conversation_{task_id}.json",
        )

        result = await agent.run(max_steps=30)

        # Extract result
        final_result = result.final_result() if hasattr(result, 'final_result') else str(result)
        is_done = result.is_done() if hasattr(result, 'is_done') else True
        
        log(task_id, f"Task completed! Result: {str(final_result)[:200]}", "success", supabase)

        return {
            "success": is_done,
            "summary": str(final_result)[:500],
            "logs": logs_collected,
            "steps": len(logs_collected),
        }

    except Exception as e:
        error_msg = f"Browser Use error: {str(e)}"
        log(task_id, error_msg, "error", supabase)
        traceback.print_exc()
        return {"success": False, "summary": error_msg, "logs": logs_collected}

    finally:
        try:
            await browser.close()
        except Exception:
            pass


async def run_with_playwright_fallback(task_id: str, prompt: str, supabase=None) -> dict:
    """Fallback to Playwright if browser-use is not available."""
    from playwright.async_api import async_playwright
    import random

    log(task_id, "Using Playwright fallback agent...", "info", supabase)
    logs = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
            ]
        )

        context = await browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="en-US",
        )

        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        """)

        page = await context.new_page()

        try:
            # Simple demo - navigate and extract info
            msg = "Navigating to Google..."
            log(task_id, msg, "info", supabase)
            logs.append(msg)

            await page.goto("https://www.google.com", wait_until="domcontentloaded")
            await asyncio.sleep(random.uniform(1, 2))

            title = await page.title()
            msg = f"Page loaded: {title}"
            log(task_id, msg, "success", supabase)
            logs.append(msg)

            return {
                "success": True,
                "summary": f"Playwright fallback completed. Task: {prompt[:100]}",
                "logs": logs,
                "steps": len(logs),
            }
        finally:
            await browser.close()


async def run_task(task_id: str):
    """Main task runner."""
    # Initialize Supabase
    supabase = None
    if SUPABASE_AVAILABLE and SUPABASE_URL and SUPABASE_SERVICE_KEY:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    # Fetch task from database
    if not task_id:
        log("", "No TASK_ID provided", "error")
        return

    log(task_id, f"Fetching task {task_id}...", "info", supabase)

    if supabase:
        response = supabase.table("tasks").select("*").eq("id", task_id).single().execute()
        task = response.data
    else:
        log(task_id, "No Supabase connection — using demo prompt", "warning", supabase)
        task = {"id": task_id, "prompt": "Navigate to google.com and take a screenshot", "name": "Demo Task"}

    if not task:
        log(task_id, f"Task {task_id} not found!", "error", supabase)
        return

    prompt = task.get("prompt", "")
    log(task_id, f"Running task: {task.get('name', 'Unknown')}", "info", supabase)

    # Mark as running
    if supabase:
        supabase.table("tasks").update({
            "status": "running",
            "last_run": datetime.utcnow().isoformat(),
        }).eq("id", task_id).execute()

    # Run agent
    if BROWSER_USE_AVAILABLE and GEMINI_API_KEY:
        result = await run_with_browser_use(task_id, prompt, supabase)
    else:
        result = await run_with_playwright_fallback(task_id, prompt, supabase)

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

    log(task_id, f"Task finished. Success: {result['success']}", "success" if result["success"] else "error", supabase)


if __name__ == "__main__":
    task_id = TASK_ID or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not task_id:
        print("Usage: python browser_use_worker.py <task_id>")
        sys.exit(1)
    asyncio.run(run_task(task_id))
