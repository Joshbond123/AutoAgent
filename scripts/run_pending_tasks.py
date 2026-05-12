#!/usr/bin/env python3
  """AutoAgent Pro — Run all pending tasks from Supabase."""
  import os, sys, asyncio, json, httpx
  from datetime import datetime

  SUPABASE_URL = os.environ.get("SUPABASE_URL","")
  SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")
  CB_KEYS      = [k.strip() for k in os.environ.get("CEREBRAS_API_KEYS","").split(",") if k.strip()]

  async def main():
      h = {"Authorization":f"Bearer {SERVICE_KEY}","apikey":SERVICE_KEY,"Content-Type":"application/json"}
      async with httpx.AsyncClient(timeout=30) as client:
          res = await client.get(f"{SUPABASE_URL}/rest/v1/tasks?status=eq.pending&select=id,name,prompt", headers=h)
          tasks = res.json() if res.status_code==200 else []
          print(f"Found {len(tasks)} pending task(s)", flush=True)
          for task in tasks:
              print(f"Running task: {task['id']} — {task['name']}", flush=True)
              proc = await asyncio.create_subprocess_exec(
                  sys.executable, "scripts/browser_use_worker.py", task["id"],
                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
              stdout, _ = await proc.communicate()
              print(stdout.decode()[-3000:], flush=True)
              print(f"Task {task['id']} exit code: {proc.returncode}", flush=True)

  if __name__=="__main__":
      asyncio.run(main())
  