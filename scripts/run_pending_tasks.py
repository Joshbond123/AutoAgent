#!/usr/bin/env python3
"""
AutoAgent Pro — Run all pending tasks from Supabase.
Fetches all tasks with status='pending', runs them sequentially via browser_use_worker.
"""
import os
import sys
import asyncio
import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


async def main():
    if not SUPABASE_URL or not SERVICE_KEY:
        print("[ERROR] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required", flush=True)
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey":        SERVICE_KEY,
        "Content-Type":  "application/json",
    }

    print("[AutoAgent] Querying Supabase for pending tasks…", flush=True)
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/tasks?status=eq.pending&select=id,prompt&order=created_at.asc",
            headers=headers,
        )

    if res.status_code != 200:
        print(f"[ERROR] Supabase query failed: {res.status_code} {res.text[:300]}", flush=True)
        sys.exit(1)

    tasks = res.json()
    print(f"[AutoAgent] Found {len(tasks)} pending task(s)", flush=True)

    if not tasks:
        print("[AutoAgent] No pending tasks — exiting", flush=True)
        return

    for task in tasks:
        tid    = task["id"]
        prompt = task.get("prompt", "")[:100]
        print(f"\n[AutoAgent] ▶ Starting task: {tid}", flush=True)
        print(f"[AutoAgent]   Prompt: {prompt}…" if len(task.get("prompt","")) > 100 else f"[AutoAgent]   Prompt: {prompt}", flush=True)
        print("=" * 60, flush=True)

        proc = await asyncio.create_subprocess_exec(
            sys.executable, "scripts/browser_use_worker.py", tid,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        output = stdout.decode(errors="replace")
        # Print last 8000 chars to capture key output
        print(output[-8000:], flush=True)
        print(f"\n[AutoAgent] Task {tid} exit code: {proc.returncode}", flush=True)
        print("=" * 60, flush=True)

    print(f"\n[AutoAgent] All {len(tasks)} task(s) processed", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
