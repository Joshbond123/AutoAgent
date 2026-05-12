/**
 * AutoAgent Pro — TypeScript Agent (Dev/Testing Reference)
 *
 * NOTE: Production task execution now uses browser-use (Python):
 *   scripts/browser_use_worker.py — the primary GitHub Actions worker
 *
 * Primary AI:  Cerebras gpt-oss-120b (via LangChain OpenAI wrapper)
 * Vision AI:   Cloudflare Workers AI kimi-k2.6 (screenshot analysis)
 * Browser:     browser-use library (Playwright + stealth + human-like behaviour)
 *
 * This TypeScript agent is kept for local dev/testing and as a reference
 * implementation. The Python worker runs in GitHub Actions for production tasks.
 */
import playwright, { Page, BrowserContext } from "playwright";
import { CerebrasClient, createCerebrasClient } from "./cerebras.js";
import { sleep, randomBetween, humanDelay } from "./utils.js";

interface AgentAction {
  action: "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "FINISH" | "GOTO" | "HOVER" |
          "PRESS_KEY" | "SCREENSHOT" | "SELECT" | "CLEAR" | "EXTRACT";
  selector?: string;
  text?: string;
  url?: string;
  key?: string;
  value?: string;
  scrollX?: number;
  scrollY?: number;
  js?: string;
  label?: string;
  reason: string;
}

export interface AgentOptions {
  taskId: string;
  prompt: string;
  cerebrasKeys?: string[];
  cloudflareAccountId?: string;
  cloudflareKeys?: string[];
  cloudflareModel?: string;
  nopechaKey?: string;
  onLog?: (message: string, type?: "info" | "success" | "error" | "warning") => void;
  onScreenshot?: (base64: string) => void;
  maxSteps?: number;
  supabase?: any;
}

const AGENT_SYSTEM_PROMPT = `You are AutoAgent Pro, an autonomous browser agent.
Analyse the current page context and return the next browser action as JSON.

Rules:
- Always return valid JSON with the exact schema — no markdown, no explanation
- Use precise CSS selectors: prefer [name="..."], [type="..."], [placeholder="..."]
- For forms: TYPE into inputs, then PRESS_KEY Enter or CLICK submit
- CAPTCHA detected → WAIT with reason "captcha_detected"
- Task complete → FINISH with detailed summary
- Be methodical: verify each action succeeded before moving on`;

export class AutonomousAgent {
  private page!: Page;
  private context!: BrowserContext;
  private browser!: playwright.Browser;
  private cerebras?: CerebrasClient;
  private cfKeys: string[] = [];
  private cfKeyIndex = 0;
  private cfAccountId = "";
  private cfModel = "@cf/moonshotai/kimi-k2.6";
  private logs: string[] = [];
  private options: AgentOptions;
  private stepCount = 0;
  private maxSteps: number;
  private pageHistory: string[] = [];
  private memory: string[] = [];

  constructor(options: AgentOptions) {
    this.options = options;
    this.maxSteps = options.maxSteps || 30;

    if (options.cerebrasKeys?.length) {
      this.cerebras = createCerebrasClient(options.cerebrasKeys);
      this.log(`Cerebras ready — ${this.cerebras.keyCount} key(s)`, "info");
    }

    if (options.cloudflareAccountId && options.cloudflareKeys?.length) {
      this.cfAccountId = options.cloudflareAccountId;
      this.cfKeys = options.cloudflareKeys.filter(k => k?.trim());
      this.cfModel = options.cloudflareModel || "@cf/moonshotai/kimi-k2.6";
      this.log(`Cloudflare AI ready — ${this.cfKeys.length} key(s), model: ${this.cfModel}`, "info");
    }

    if (!this.cerebras && !this.cfKeys.length) {
      throw new Error("At least one AI provider must be configured (Cerebras or Cloudflare)");
    }
  }

  private log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
    const entry = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}`;
    this.logs.push(entry);
    this.options.onLog?.(message, type);
  }

  private nextCfKey(): string | null {
    if (!this.cfKeys.length) return null;
    const key = this.cfKeys[this.cfKeyIndex % this.cfKeys.length];
    this.cfKeyIndex = (this.cfKeyIndex + 1) % this.cfKeys.length;
    return key;
  }

  async initialize(): Promise<void> {
    this.log("Launching stealth browser…", "info");

    this.browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-infobars", "--window-size=1366,768",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--no-first-run", "--no-zygote",
      ],
    });

    const w = randomBetween(1280, 1440);
    const h = randomBetween(700, 800);

    this.context = await this.browser.newContext({
      viewport: { width: w, height: h },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      permissions: ["geolocation"],
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      (window as any).chrome = { runtime: {} };
    });

    this.page = await this.context.newPage();
    this.page.on("load", async () => { await sleep(randomBetween(200, 600)); });
    this.log(`Browser ready (${w}x${h}, stealth enabled)`, "success");
  }

  private async humanClick(selector: string): Promise<void> {
    try {
      const el = await this.page.waitForSelector(selector, { timeout: 8000, state: "visible" });
      if (!el) throw new Error(`Not found: ${selector}`);
      const box = await el.boundingBox();
      if (!box) throw new Error(`No bounding box: ${selector}`);
      const tx = box.x + box.width / 2 + randomBetween(-4, 4);
      const ty = box.y + box.height / 2 + randomBetween(-3, 3);
      await this.page.mouse.move(tx - randomBetween(50, 150), ty - randomBetween(20, 60), { steps: 5 });
      await humanDelay(80, 200);
      await this.page.mouse.move(tx, ty, { steps: randomBetween(10, 25) });
      await humanDelay(40, 100);
      await this.page.mouse.down();
      await humanDelay(40, 100);
      await this.page.mouse.up();
    } catch {
      await this.page.click(selector, { timeout: 5000 }).catch(() => {});
    }
  }

  private async humanType(selector: string, text: string): Promise<void> {
    await this.humanClick(selector);
    await humanDelay(100, 250);
    await this.page.keyboard.press("Control+a");
    await humanDelay(50, 100);
    for (const char of text) {
      await this.page.keyboard.type(char, { delay: randomBetween(45, 130) });
      if (Math.random() < 0.03) await sleep(randomBetween(400, 800));
    }
  }

  private async humanScroll(x = 0, y = 300): Promise<void> {
    const steps = randomBetween(4, 9);
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(x / steps, y / steps);
      await sleep(randomBetween(35, 80));
    }
  }

  private async takeScreenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
    return buf.toString("base64");
  }

  private async getPageContext(): Promise<string> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => "Unknown");
    const elements = await this.page.evaluate(() => {
      const get = (sel: string) => Array.from(document.querySelectorAll(sel)).slice(0, 12).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el as any).type || "",
        name: (el as any).name || "",
        id: el.id || "",
        placeholder: (el as any).placeholder || "",
        text: el.textContent?.trim().slice(0, 60) || "",
      }));
      return {
        inputs: get("input:not([type=hidden]),textarea,select"),
        buttons: get("button,a,input[type=submit],input[type=button],[role=button]"),
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 5).map(h => h.textContent?.trim()),
        bodyText: document.body.innerText.slice(0, 2000),
        hasCaptcha: !!(document.querySelector(".g-recaptcha,[data-sitekey],.h-captcha")),
        errors: Array.from(document.querySelectorAll('[class*="error"],[role="alert"]')).slice(0, 3).map(e => e.textContent?.trim()),
        links: Array.from(document.querySelectorAll("a[href]")).slice(0, 8).map(a => ({ text: a.textContent?.trim().slice(0, 50), href: (a as HTMLAnchorElement).href })),
      };
    }).catch(() => ({ inputs: [], buttons: [], headings: [], bodyText: "", hasCaptcha: false, errors: [], links: [] }));

    const memStr = this.memory.length > 0 ? `\nEXTRACTED: ${this.memory.slice(-4).join(" | ")}` : "";

    return `URL: ${url}
TITLE: ${title}
STEP: ${this.stepCount}/${this.maxSteps}
CAPTCHA: ${elements.hasCaptcha}
HEADINGS: ${elements.headings?.join(" | ") || "none"}
PAGE TEXT:\n${elements.bodyText.slice(0, 1500)}
INPUTS: ${JSON.stringify(elements.inputs.slice(0, 6))}
BUTTONS: ${JSON.stringify(elements.buttons?.slice(0, 8))}
LINKS: ${JSON.stringify(elements.links.slice(0, 6))}
ERRORS: ${elements.errors?.join(" | ") || "none"}
PREV PAGES: ${this.pageHistory.slice(-3).join(" → ")}${memStr}`;
  }

  private async decideWithCerebras(pageContext: string): Promise<AgentAction> {
    const messages = [{
      role: "user" as const,
      content: `OBJECTIVE: ${this.options.prompt}\n\nCURRENT STATE:\n${pageContext}\n\nReturn ONE JSON action object. Actions: CLICK, TYPE, SCROLL, WAIT, FINISH, GOTO, HOVER, PRESS_KEY, SELECT, CLEAR, EXTRACT\nRequired fields depend on action. Always include "reason". Return raw JSON only.`,
    }];
    return this.cerebras!.chatJSON<AgentAction>(messages, { systemPrompt: AGENT_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 512 });
  }

  private async decideWithCloudflare(screenshot: string): Promise<AgentAction> {
    const key = this.nextCfKey();
    if (!key) throw new Error("No Cloudflare keys available");

    const pageUrl = this.page.url();
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.cfAccountId}/ai/run/${this.cfModel}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${screenshot}` } },
              {
                type: "text",
                text: `OBJECTIVE: ${this.options.prompt}\nURL: ${pageUrl}\nStep: ${this.stepCount}\n\nReturn ONE JSON action: {"action":"CLICK|TYPE|SCROLL|WAIT|FINISH|GOTO","selector":"CSS","text":"","url":"","key":"","scrollX":0,"scrollY":300,"reason":"why"}\nRaw JSON only.`,
              },
            ],
          }],
        }),
      }
    );

    if (res.status === 429) throw new Error("Cloudflare rate limited");
    if (!res.ok) throw new Error(`Cloudflare API error ${res.status}`);

    const data = await res.json();
    const text = data?.result?.response || "{}";
    try {
      const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
      return JSON.parse(m ? (m[1] || m[0]) : text);
    } catch {
      return { action: "WAIT", reason: "Cloudflare JSON parse error" };
    }
  }

  private async executeAction(action: AgentAction): Promise<boolean> {
    this.log(`[${action.action}] ${action.reason}`, "info");
    try {
      switch (action.action) {
        case "GOTO": {
          const url = action.url || "";
          if (!url) throw new Error("No URL for GOTO");
          await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          this.pageHistory.push(url);
          await sleep(randomBetween(600, 1500));
          break;
        }
        case "CLICK":
          await this.humanClick(action.selector!);
          await sleep(randomBetween(300, 700));
          break;
        case "TYPE":
          await this.humanType(action.selector!, action.text || "");
          await sleep(randomBetween(200, 400));
          break;
        case "CLEAR":
          await this.page.fill(action.selector!, "");
          break;
        case "SELECT":
          await this.page.selectOption(action.selector!, action.value || action.text || "");
          await sleep(200);
          break;
        case "SCROLL":
          await this.humanScroll(action.scrollX || 0, action.scrollY || 300);
          await sleep(randomBetween(200, 400));
          break;
        case "HOVER":
          await this.page.hover(action.selector!, { timeout: 5000 });
          await sleep(randomBetween(300, 600));
          break;
        case "PRESS_KEY":
          await this.page.keyboard.press(action.key || "Enter");
          await sleep(randomBetween(300, 600));
          break;
        case "SCREENSHOT": {
          const ss = await this.takeScreenshot();
          this.options.onScreenshot?.(ss);
          break;
        }
        case "EXTRACT": {
          if (action.js) {
            const result = await this.page.evaluate(action.js).catch(() => null);
            const str = String(result || "").slice(0, 600);
            this.memory.push(`${action.label || "data"}: ${str}`);
            this.log(`Extracted [${action.label}]: ${str.slice(0, 200)}`, "success");
          }
          break;
        }
        case "WAIT": {
          const ms = action.reason?.includes("captcha") ? 8000 : randomBetween(1500, 3500);
          await sleep(ms);
          break;
        }
        case "FINISH":
          this.log(`Task complete: ${action.reason}`, "success");
          if (this.memory.length) this.log(`Collected: ${this.memory.join(" | ")}`, "success");
          return true;
      }
    } catch (err: any) {
      this.log(`Action failed: ${err.message}`, "warning");
      if (action.selector && (action.action === "CLICK" || action.action === "TYPE")) {
        try {
          await this.page.evaluate(sel => {
            document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, action.selector);
          await sleep(600);
          if (action.action === "CLICK") await this.page.click(action.selector, { timeout: 5000 });
          else await this.page.fill(action.selector, action.text || "");
          this.log(`Retry succeeded for ${action.selector}`, "info");
        } catch (retryErr: any) {
          this.log(`Retry failed: ${retryErr.message}`, "warning");
        }
      }
    }
    return false;
  }

  async run(): Promise<{ success: boolean; logs: string[]; summary: string; steps: number }> {
    try {
      await this.initialize();
      this.log(`Starting task: ${this.options.prompt.slice(0, 100)}`, "info");

      const urlMatch = this.options.prompt.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        await this.executeAction({ action: "GOTO", url: urlMatch[0], reason: "Navigate to target URL" });
      }

      const recentActions: string[] = [];
      let consecutiveWaits = 0;

      while (this.stepCount < this.maxSteps) {
        this.stepCount++;
        this.log(`Step ${this.stepCount}/${this.maxSteps}`, "info");

        const screenshot = await this.takeScreenshot();
        this.options.onScreenshot?.(screenshot);

        if (recentActions.length >= 4 && new Set(recentActions.slice(-4)).size === 1) {
          this.log("Loop detected — stopping", "warning");
          break;
        }
        if (consecutiveWaits >= 5) {
          this.log("Too many WAITs — stopping", "warning");
          break;
        }

        let action: AgentAction;
        try {
          if (this.cerebras) {
            const ctx = await this.getPageContext();
            action = await this.decideWithCerebras(ctx);
            this.log(`Cerebras: ${action.action} — ${action.reason?.slice(0, 80)}`, "info");
          } else {
            action = await this.decideWithCloudflare(screenshot);
            this.log(`Cloudflare: ${action.action} — ${action.reason?.slice(0, 80)}`, "info");
          }
        } catch (err: any) {
          this.log(`AI error: ${err.message} — trying Cloudflare vision…`, "warning");
          try {
            if (this.cfKeys.length > 0) {
              action = await this.decideWithCloudflare(screenshot);
            } else {
              action = { action: "WAIT", reason: "AI error, waiting…" };
            }
          } catch {
            action = { action: "WAIT", reason: "All AI providers failed" };
          }
        }

        const actionKey = `${action.action}:${action.url || action.selector || ""}`.slice(0, 60);
        recentActions.push(actionKey);
        if (recentActions.length > 8) recentActions.shift();
        consecutiveWaits = action.action === "WAIT" ? consecutiveWaits + 1 : 0;

        const done = await this.executeAction(action);
        if (done || action.action === "FINISH") break;

        await sleep(randomBetween(500, 1200));
      }

      const summary = this.memory.length
        ? `Collected data: ${this.memory.join(" | ")}`
        : this.logs.slice(-3).join(" | ");
      return { success: true, logs: this.logs, summary, steps: this.stepCount };
    } catch (err: any) {
      this.log(`Fatal: ${err.message}`, "error");
      return { success: false, logs: this.logs, summary: `Error: ${err.message}`, steps: this.stepCount };
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    try { await this.browser?.close(); } catch { /* ignore */ }
  }

  getLogs(): string[] { return this.logs; }
}
