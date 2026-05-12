/**
 * AutoAgent Pro — Autonomous Browser Agent
 * Primary AI: Cerebras gpt-oss-120b (ultra-fast inference)
 * Fallback: Google Gemini 2.0 Flash (vision)
 * Browser: Playwright with stealth & human-like behavior
 */
import playwright, { Page, BrowserContext } from "playwright";
import { GoogleGenAI } from "@google/genai";
import { CerebrasClient, createCerebrasClient } from "./cerebras.js";
import { sleep, randomBetween, humanDelay } from "./utils.js";

interface AgentAction {
  action: "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "FINISH" | "GOTO" | "HOVER" | "PRESS_KEY" | "SCREENSHOT" | "SELECT" | "CLEAR";
  selector?: string;
  text?: string;
  url?: string;
  key?: string;
  value?: string;
  scrollX?: number;
  scrollY?: number;
  reason: string;
}

export interface AgentOptions {
  taskId: string;
  prompt: string;
  cerebrasKeys?: string[];
  geminiApiKey?: string;
  nopechaKey?: string;
  onLog?: (message: string, type?: "info" | "success" | "error" | "warning") => void;
  onScreenshot?: (base64: string) => void;
  maxSteps?: number;
  supabase?: any;
}

const AGENT_SYSTEM_PROMPT = `You are AutoAgent Pro, an autonomous browser agent using Cerebras gpt-oss-120b.
Your job is to analyze web page screenshots and decide the next browser action to complete the user's task.

Rules:
- Always return valid JSON with the exact schema provided
- Use precise CSS selectors: prefer [name="..."], [type="..."], [placeholder="..."], button:has-text("...")
- For forms: TYPE into inputs, then PRESS_KEY Enter or CLICK submit
- If a CAPTCHA is detected, use WAIT action with reason "captcha_detected"
- If the task is complete, use FINISH with a detailed summary in the reason field
- Be methodical: don't skip steps, verify each action succeeded before moving on`;

export class AutonomousAgent {
  private page!: Page;
  private context!: BrowserContext;
  private browser!: playwright.Browser;
  private cerebras?: CerebrasClient;
  private genAI?: GoogleGenAI;
  private logs: string[] = [];
  private options: AgentOptions;
  private stepCount = 0;
  private maxSteps: number;
  private pageHistory: string[] = [];

  constructor(options: AgentOptions) {
    this.options = options;
    this.maxSteps = options.maxSteps || 30;

    // Initialize Cerebras (primary)
    if (options.cerebrasKeys && options.cerebrasKeys.length > 0) {
      this.cerebras = createCerebrasClient(options.cerebrasKeys);
      this.log(`Cerebras initialized with ${this.cerebras.keyCount} key(s), model: gpt-oss-120b`, "info");
    }

    // Initialize Gemini (vision fallback)
    if (options.geminiApiKey) {
      this.genAI = new GoogleGenAI({ apiKey: options.geminiApiKey });
    }

    if (!this.cerebras && !this.genAI) {
      throw new Error("At least one AI provider (Cerebras or Gemini) must be configured");
    }
  }

  private log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
    const entry = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}`;
    this.logs.push(entry);
    this.options.onLog?.(message, type);
    console.log(entry);
  }

  async initialize(): Promise<void> {
    this.log("Launching stealth browser (Playwright + anti-detection)...", "info");

    this.browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-infobars",
        "--window-size=1366,768",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    });

    const viewportWidth = randomBetween(1280, 1440);
    const viewportHeight = randomBetween(700, 800);

    this.context = await this.browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "AppleWebKit/537.36 (KHTML, like Gecko)",
        "Chrome/124.0.0.0 Safari/537.36"
      ].join(" "),
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

    // Stealth injection
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

      const origQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (p: any) =>
        p.name === "notifications"
          ? Promise.resolve({ state: "denied" } as PermissionStatus)
          : origQuery(p);

      // Mask chrome automation
      (window as any).chrome = { runtime: {} };
    });

    this.page = await this.context.newPage();

    // Random human-like page load behavior
    this.page.on("load", async () => {
      await sleep(randomBetween(300, 800));
    });

    this.log(`Browser ready (${viewportWidth}x${viewportHeight}, stealth enabled)`, "success");
  }

  private async humanClick(selector: string): Promise<void> {
    try {
      const element = await this.page.waitForSelector(selector, { timeout: 8000, state: "visible" });
      if (!element) throw new Error(`Element not found: ${selector}`);

      const box = await element.boundingBox();
      if (!box) throw new Error(`Cannot get bounding box for: ${selector}`);

      // Natural mouse trajectory to element
      const targetX = box.x + box.width / 2 + randomBetween(-4, 4);
      const targetY = box.y + box.height / 2 + randomBetween(-3, 3);

      await this.page.mouse.move(targetX - randomBetween(50, 150), targetY - randomBetween(20, 60), { steps: 5 });
      await humanDelay(80, 200);
      await this.page.mouse.move(targetX, targetY, { steps: randomBetween(10, 25) });
      await humanDelay(40, 100);
      await this.page.mouse.down();
      await humanDelay(40, 100);
      await this.page.mouse.up();
    } catch {
      // Fallback to direct click
      await this.page.click(selector, { timeout: 5000 });
    }
  }

  private async humanType(selector: string, text: string): Promise<void> {
    await this.humanClick(selector);
    await humanDelay(100, 250);
    await this.page.keyboard.press("Control+a");
    await humanDelay(50, 100);

    for (const char of text) {
      await this.page.keyboard.type(char, { delay: randomBetween(45, 130) });
      if (Math.random() < 0.03) await sleep(randomBetween(400, 800)); // Random thinking pause
    }
  }

  private async humanScroll(x: number = 0, y: number = 300): Promise<void> {
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

  private async decideWithCerebras(pageContext: string, objective: string): Promise<AgentAction> {
    const messages = [{
      role: "user" as const,
      content: `OBJECTIVE: ${objective}

CURRENT STATE:
${pageContext}

Return a JSON action object:
{
  "action": "CLICK|TYPE|SCROLL|WAIT|FINISH|GOTO|HOVER|PRESS_KEY|SELECT|CLEAR",
  "selector": "CSS selector",
  "text": "text to type",
  "url": "URL for GOTO",
  "key": "key for PRESS_KEY",
  "scrollX": 0,
  "scrollY": 400,
  "value": "value for SELECT",
  "reason": "clear explanation of why"
}

Return FINISH when the objective is complete. Only return JSON, no markdown.`,
    }];

    const response = await this.cerebras!.chatJSON<AgentAction>(messages, {
      systemPrompt: AGENT_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 512,
    });

    return response;
  }

  private async decideWithGemini(screenshot: string, objective: string): Promise<AgentAction> {
    const pageUrl = this.page.url();
    const response = await this.genAI!.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: screenshot } },
          {
            text: `OBJECTIVE: ${objective}
URL: ${pageUrl}
Step: ${this.stepCount}

Return JSON action:
{"action":"CLICK|TYPE|SCROLL|WAIT|FINISH|GOTO","selector":"CSS","text":"","url":"","key":"","scrollX":0,"scrollY":300,"reason":"why"}`
          },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 512 },
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    try {
      return JSON.parse(text);
    } catch {
      return { action: "WAIT", reason: "JSON parse error from Gemini" };
    }
  }

  private async getPageContext(): Promise<string> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => "Unknown");

    // Extract key interactive elements for Cerebras (text-based reasoning)
    const elements = await this.page.evaluate(() => {
      const getElements = (sel: string) =>
        Array.from(document.querySelectorAll(sel))
          .slice(0, 12)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: (el as any).type || "",
            name: (el as any).name || "",
            id: el.id || "",
            placeholder: (el as any).placeholder || "",
            text: el.textContent?.trim().slice(0, 60) || "",
            class: el.className?.toString().split(" ").slice(0, 3).join(" ") || "",
          }));

      return {
        inputs: getElements("input:not([type=hidden]),textarea,select"),
        buttons: getElements("button,a,input[type=submit],input[type=button]"),
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 5).map(h => h.textContent?.trim()),
        hasRecaptcha: !!document.querySelector(".g-recaptcha,[data-sitekey]"),
        hasHcaptcha: !!document.querySelector(".h-captcha"),
        formCount: document.querySelectorAll("form").length,
        errorMessages: Array.from(document.querySelectorAll('[class*="error"],[class*="alert"],[role="alert"]')).slice(0, 3).map(e => e.textContent?.trim()),
      };
    });

    return `URL: ${url}
Title: ${title}
Step: ${this.stepCount}/${this.maxSteps}
CAPTCHA detected: ${elements.hasRecaptcha || elements.hasHcaptcha}

PAGE ELEMENTS:
Headings: ${elements.headings?.join(" | ") || "none"}
Inputs: ${JSON.stringify(elements.inputs)}
Buttons: ${JSON.stringify(elements.buttons?.slice(0, 8))}
Forms: ${elements.formCount}
Errors: ${elements.errorMessages?.join(" | ") || "none"}
Previous pages: ${this.pageHistory.slice(-3).join(" → ")}`;
  }

  private async executeAction(action: AgentAction): Promise<boolean> {
    this.log(`[${action.action}] ${action.reason}`, "info");

    try {
      switch (action.action) {
        case "GOTO":
          const url = action.url || "";
          if (!url) throw new Error("No URL for GOTO");
          await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          this.pageHistory.push(url);
          await sleep(randomBetween(600, 1500));
          break;

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

        case "SCREENSHOT":
          const ss = await this.takeScreenshot();
          this.options.onScreenshot?.(ss);
          break;

        case "WAIT":
          const waitTime = action.reason?.includes("captcha") ? 8000 : randomBetween(1500, 3500);
          this.log(`Waiting ${waitTime}ms (${action.reason})`, "info");
          await sleep(waitTime);
          break;

        case "FINISH":
          this.log(`Task complete: ${action.reason}`, "success");
          return true; // Signal completion
      }
    } catch (err: any) {
      this.log(`Action failed: ${err.message}`, "warning");

      // Try scroll into view then retry for visibility issues
      if (action.selector && (action.action === "CLICK" || action.action === "TYPE")) {
        try {
          await this.page.evaluate((sel) => {
            document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, action.selector);
          await sleep(600);

          if (action.action === "CLICK") await this.page.click(action.selector, { timeout: 5000 });
          else if (action.action === "TYPE") await this.page.fill(action.selector, action.text || "");

          this.log(`Retry succeeded for ${action.selector}`, "info");
        } catch (retryErr: any) {
          this.log(`Retry also failed: ${retryErr.message}`, "warning");
        }
      }
    }

    return false; // Not finished
  }

  async run(): Promise<{ success: boolean; logs: string[]; summary: string; steps: number }> {
    try {
      await this.initialize();
      this.log(`Starting: ${this.options.prompt}`, "info");

      // Start with GOTO if prompt contains a URL
      const urlMatch = this.options.prompt.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        await this.executeAction({ action: "GOTO", url: urlMatch[0], reason: "Navigate to target URL" });
      }

      while (this.stepCount < this.maxSteps) {
        this.stepCount++;
        this.log(`Step ${this.stepCount}/${this.maxSteps}`, "info");

        // Take screenshot for vision (always needed for Gemini fallback)
        const screenshot = await this.takeScreenshot();
        this.options.onScreenshot?.(screenshot);

        // Decide next action: Cerebras (text) first, Gemini (vision) as fallback
        let action: AgentAction;
        try {
          if (this.cerebras) {
            const pageContext = await this.getPageContext();
            action = await this.decideWithCerebras(pageContext, this.options.prompt);
            this.log(`Cerebras decision (${this.cerebras.activeKeys}/${this.cerebras.keyCount} keys active): ${action.action}`, "info");
          } else {
            action = await this.decideWithGemini(screenshot, this.options.prompt);
            this.log(`Gemini decision: ${action.action}`, "info");
          }
        } catch (err: any) {
          this.log(`AI error: ${err.message} — falling back...`, "warning");

          // Try Gemini if Cerebras fails
          if (this.genAI) {
            try {
              action = await this.decideWithGemini(screenshot, this.options.prompt);
            } catch {
              action = { action: "WAIT", reason: "Both AI providers failed, waiting..." };
            }
          } else {
            action = { action: "WAIT", reason: "AI error, retrying..." };
          }
        }

        // Execute and check if done
        const done = await this.executeAction(action);
        if (done || action.action === "FINISH") break;

        // Natural pace between steps
        await sleep(randomBetween(500, 1200));
      }

      const summary = this.logs.slice(-3).join(" | ");
      return { success: true, logs: this.logs, summary, steps: this.stepCount };

    } catch (err: any) {
      this.log(`Fatal error: ${err.message}`, "error");
      return { success: false, logs: this.logs, summary: `Error: ${err.message}`, steps: this.stepCount };
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.browser?.close();
      this.log("Browser closed cleanly", "info");
    } catch { /* ignore */ }
  }

  getLogs(): string[] { return this.logs; }
}
