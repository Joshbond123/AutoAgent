#!/usr/bin/env python3
"""
AutoAgent Pro - CAPTCHA Handler
Supports: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, JS challenges
"""

import asyncio
import os
import time
import httpx
from typing import Optional

NOPECHA_API_KEY = os.environ.get("NOPECHA_API_KEY", "")
NOPECHA_BASE = "https://api.nopecha.com"


async def solve_recaptcha_v2(sitekey: str, url: str, api_key: str = NOPECHA_API_KEY) -> Optional[str]:
    """Solve reCAPTCHA v2 using NopeCHA."""
    if not api_key:
        print("[CAPTCHA] No NopeCHA key — skipping reCAPTCHA v2 solve")
        return None

    async with httpx.AsyncClient(timeout=120) as client:
        # Submit task
        res = await client.post(f"{NOPECHA_BASE}/", json={
            "type": "recaptchav2",
            "sitekey": sitekey,
            "url": url,
            "key": api_key,
        })
        data = res.json()
        if data.get("error"):
            print(f"[CAPTCHA] Submit error: {data['error']}")
            return None

        task_id = data.get("id")
        print(f"[CAPTCHA] reCAPTCHA v2 task submitted: {task_id}")

        # Poll for result
        for _ in range(60):
            await asyncio.sleep(3)
            res = await client.get(f"{NOPECHA_BASE}/", params={"key": api_key, "id": task_id})
            data = res.json()
            if not data.get("error") and data.get("data"):
                token = data["data"][0] if isinstance(data["data"], list) else data["data"]
                print(f"[CAPTCHA] reCAPTCHA v2 solved! Token: {str(token)[:30]}...")
                return token

        print("[CAPTCHA] reCAPTCHA v2 timeout")
        return None


async def solve_recaptcha_v3(sitekey: str, url: str, action: str = "submit", api_key: str = NOPECHA_API_KEY) -> Optional[str]:
    """Solve reCAPTCHA v3 using NopeCHA."""
    if not api_key:
        return None

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(f"{NOPECHA_BASE}/", json={
            "type": "recaptchav3",
            "sitekey": sitekey,
            "url": url,
            "action": action,
            "key": api_key,
        })
        data = res.json()
        task_id = data.get("id")
        if not task_id:
            return None

        for _ in range(40):
            await asyncio.sleep(2)
            res = await client.get(f"{NOPECHA_BASE}/", params={"key": api_key, "id": task_id})
            data = res.json()
            if not data.get("error") and data.get("data"):
                token = data["data"][0] if isinstance(data["data"], list) else data["data"]
                print(f"[CAPTCHA] reCAPTCHA v3 solved!")
                return token

        return None


async def solve_hcaptcha(sitekey: str, url: str, api_key: str = NOPECHA_API_KEY) -> Optional[str]:
    """Solve hCaptcha using NopeCHA."""
    if not api_key:
        return None

    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(f"{NOPECHA_BASE}/", json={
            "type": "hcaptcha",
            "sitekey": sitekey,
            "url": url,
            "key": api_key,
        })
        data = res.json()
        task_id = data.get("id")
        if not task_id:
            print(f"[CAPTCHA] hCaptcha submit failed: {data}")
            return None

        print(f"[CAPTCHA] hCaptcha task submitted: {task_id}")
        for _ in range(60):
            await asyncio.sleep(3)
            res = await client.get(f"{NOPECHA_BASE}/", params={"key": api_key, "id": task_id})
            data = res.json()
            if not data.get("error") and data.get("data"):
                token = data["data"][0] if isinstance(data["data"], list) else data["data"]
                print(f"[CAPTCHA] hCaptcha solved!")
                return token

        return None


async def solve_turnstile(sitekey: str, url: str, api_key: str = NOPECHA_API_KEY) -> Optional[str]:
    """Solve Cloudflare Turnstile using NopeCHA."""
    if not api_key:
        return None

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(f"{NOPECHA_BASE}/", json={
            "type": "turnstile",
            "sitekey": sitekey,
            "url": url,
            "key": api_key,
        })
        data = res.json()
        task_id = data.get("id")
        if not task_id:
            return None

        for _ in range(40):
            await asyncio.sleep(2)
            res = await client.get(f"{NOPECHA_BASE}/", params={"key": api_key, "id": task_id})
            data = res.json()
            if not data.get("error") and data.get("data"):
                token = data["data"][0] if isinstance(data["data"], list) else data["data"]
                print(f"[CAPTCHA] Turnstile solved!")
                return token

        return None


async def inject_captcha_token(page, token: str, captcha_type: str = "recaptcha"):
    """Inject solved CAPTCHA token into the page."""
    if captcha_type in ("recaptcha", "recaptchav2", "recaptchav3"):
        await page.evaluate(f"""
            document.getElementById('g-recaptcha-response') && 
            (document.getElementById('g-recaptcha-response').innerHTML = '{token}');
            
            if (typeof ___grecaptcha_cfg !== 'undefined') {{
                Object.entries(___grecaptcha_cfg.clients).forEach(([id, client]) => {{
                    try {{
                        const cb = client.DDD?.callback || client.l?.callback || client.callback;
                        if (typeof cb === 'function') cb('{token}');
                    }} catch(e) {{}}
                }});
            }}
        """)
    elif captcha_type == "hcaptcha":
        await page.evaluate(f"""
            document.querySelector('[name="h-captcha-response"]') &&
            (document.querySelector('[name="h-captcha-response"]').value = '{token}');
            
            if (window.hcaptcha) {{
                window.hcaptcha.execute = () => Promise.resolve('{token}');
            }}
        """)
    elif captcha_type == "turnstile":
        await page.evaluate(f"""
            document.querySelector('[name="cf-turnstile-response"]') &&
            (document.querySelector('[name="cf-turnstile-response"]').value = '{token}');
        """)


async def detect_and_solve_captcha(page, api_key: str = NOPECHA_API_KEY) -> bool:
    """Auto-detect and solve any CAPTCHA on the current page."""
    url = page.url
    content = await page.content()

    # Detect reCAPTCHA v2
    if 'g-recaptcha' in content or 'recaptcha' in content.lower():
        import re
        sitekey_match = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if sitekey_match:
            sitekey = sitekey_match.group(1)
            print(f"[CAPTCHA] Detected reCAPTCHA v2 (sitekey: {sitekey[:20]}...)")
            token = await solve_recaptcha_v2(sitekey, url, api_key)
            if token:
                await inject_captcha_token(page, token, "recaptcha")
                return True

    # Detect hCaptcha
    if 'hcaptcha' in content.lower():
        import re
        sitekey_match = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if sitekey_match:
            sitekey = sitekey_match.group(1)
            print(f"[CAPTCHA] Detected hCaptcha (sitekey: {sitekey[:20]}...)")
            token = await solve_hcaptcha(sitekey, url, api_key)
            if token:
                await inject_captcha_token(page, token, "hcaptcha")
                return True

    # Detect Cloudflare Turnstile
    if 'turnstile' in content.lower() or 'cf-turnstile' in content:
        import re
        sitekey_match = re.search(r'data-sitekey=["\']([^"\']+)["\']', content)
        if sitekey_match:
            sitekey = sitekey_match.group(1)
            print(f"[CAPTCHA] Detected Cloudflare Turnstile (sitekey: {sitekey[:20]}...)")
            token = await solve_turnstile(sitekey, url, api_key)
            if token:
                await inject_captcha_token(page, token, "turnstile")
                return True

    # Detect Cloudflare JS challenge
    if 'Just a moment' in content or 'Checking your browser' in content:
        print("[CAPTCHA] Detected Cloudflare JS challenge — waiting for auto-solve...")
        await asyncio.sleep(10)
        return True

    return False
