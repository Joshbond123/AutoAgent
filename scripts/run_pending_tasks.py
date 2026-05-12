#!/usr/bin/env python3
"""AutoAgent Pro — Run all pending tasks from Supabase."""
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

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/tasks?status=eq.pending&select=id,name,prompt&order=created_at.asc",
            headers=headers,
        )

    if res.status_code != 200:
        print(f"[ERROR] Supabase query failed: {res.status_code} {res.text[:200]}", flush=True)
        sys.exit(1)

    tasks = res.json()
    print(f"[AutoAgent] Found {len(tasks)} pending task(s)", flush=True)

    if not tasks:
        print("[AutoAgent] No pending tasks — exiting", flush=True)
        return

    for task in tasks:
        tid  = task["id"]
        name = task.get("name", "unnamed")
        print(f"\n[AutoAgent] ▶ Starting task: {tid} — {name}", flush=True)
        print("=" * 60, flush=True)

        proc = await asyncio.create_subprocess_exec(
            sys.executable, "scripts/browser_use_worker.py", tid,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        output = stdout.decode(errors="replace")
        # Print last 4000 chars to avoid log overflow
        print(output[-4000:], flush=True)
        print(f"\n[AutoAgent] Task {tid} exit code: {proc.returncode}", flush=True)
        print("=" * 60, flush=True)

    print(f"\n[AutoAgent] All {len(tasks)} task(s) processed", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
