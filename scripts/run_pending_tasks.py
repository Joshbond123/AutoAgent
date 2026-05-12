#!/usr/bin/env python3
"""Run all pending tasks from Supabase."""
import asyncio
import os
import sys
from datetime import datetime

try:
    from supabase import create_client
except ImportError:
    print("supabase-py not installed"); sys.exit(1)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

async def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("Missing Supabase credentials"); sys.exit(1)

    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    response = supabase.table("tasks").select("id,name").in_("status", ["pending","scheduled"]).order("created_at").limit(5).execute()
    tasks = response.data or []

    if not tasks:
        print("No pending tasks found."); return

    print(f"Found {len(tasks)} pending task(s).")
    for task in tasks:
        print(f"\n--- Running task: {task['name']} ({task['id']}) ---")
        env = os.environ.copy()
        env["TASK_ID"] = task["id"]
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "scripts/browser_use_worker.py", task["id"],
            env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        stdout, _ = await proc.communicate()
        print(stdout.decode() if stdout else "")

asyncio.run(main())
