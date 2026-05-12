import playwright, { Page, BrowserContext } from "playwright";
import { GoogleGenAI, Type } from "@google/genai";
import CryptoJS from "crypto-js";
import { sleep, randomBetween, humanDelay } from "./utils.js";

interface AgentAction {
  action: "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "FINISH" | "GOTO" | "SCREENSHOT" | "HOVER" | "PRESS_KEY";
  selector?: string;
  text?: string;
  url?: string;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  reason: string;
}

interface AgentOptions {
  taskId: string;
  prompt: string;
  geminiApiKey: string;
  nopechaKey?: string;
  onLog?: (message: string, type?: "info" | "success" | "error" | "warning") => void;
  onScreenshot?: (base64: string) => void;
  maxSteps?: number;
  supabase?: any;
}

export class AutonomousAgent {
  private page!: Page;
  private context!: BrowserContext;
  private browser!: playwright.Browser;
  private genAI: GoogleGenAI;
  private logs: string[] = [];
  private options: AgentOptions;
  private stepCount = 0;
  private maxSteps: number;

  constructor(options: AgentOptions) {
    this.options = options;
    this.maxSteps = options.maxSteps || 30;
    this.genAI = new GoogleGenAI({ apiKey: options.geminiApiKey });
  }

  private log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
    this.logs.push(entry);
    this.options.onLog?.(message, type);
    console.log(entry);
  }

  async initialize(): Promise<void> {
    this.log("Launching browser with stealth settings...", "info");

    this.browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-infobars",
        "--window-size=1366,768",
      ],
    });

    // Randomize viewport slightly to avoid fingerprinting
    const viewportWidth = randomBetween(1280, 1440);
    const viewportHeight = randomBetween(720, 800);

    this.context = await this.browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { longitude: -73.935242, latitude: 40.730610 },
      permissions: ["geolocation"],
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });

    // Inject stealth scripts
    await this.context.addInitScript(() => {
      // Hide webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Fake plugins
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // Fake languages
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: "denied" } as PermissionStatus)
          : originalQuery(parameters);
    });

    this.page = await this.context.newPage();

    // Realistic mouse movement on navigation
    this.page.on("load", async () => {
      await sleep(randomBetween(200, 600));
    });

    this.log("Browser initialized with human-like fingerprint", "success");
  }

  private async humanClick(selector: string): Promise<void> {
    const element = await this.page.$(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);

    const box = await element.boundingBox();
    if (!box) throw new Error(`Cannot get bounding box for: ${selector}`);

    // Move to element with slight randomization
    const targetX = box.x + box.width / 2 + randomBetween(-5, 5);
    const targetY = box.y + box.height / 2 + randomBetween(-3, 3);

    await this.page.mouse.move(targetX, targetY, { steps: randomBetween(8, 20) });
    await humanDelay(50, 150);
    await this.page.mouse.down();
    await humanDelay(50, 120);
    await this.page.mouse.up();
  }

  private async humanType(selector: string, text: string): Promise<void> {
    await this.humanClick(selector);
    await humanDelay(100, 300);

    // Clear existing value
    await this.page.keyboard.press("Control+a");
    await humanDelay(50, 100);
    await this.page.keyboard.press("Delete");
    await humanDelay(50, 150);

    // Type character by character with natural delays
    for (const char of text) {
      await this.page.keyboard.type(char, { delay: randomBetween(40, 140) });
      // Occasional longer pauses (simulating thinking)
      if (Math.random() < 0.05) {
        await sleep(randomBetween(300, 700));
      }
    }
  }

  private async humanScroll(x: number = 0, y: number = 300): Promise<void> {
    // Simulate natural scroll with easing
    const steps = randomBetween(3, 8);
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(x / steps, y / steps);
      await sleep(randomBetween(30, 80));
    }
  }

  private async takeScreenshot(): Promise<string> {
    const buffer = await this.page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    return buffer.toString("base64");
  }

  private async decideNextAction(screenshot: string, objective: string): Promise<AgentAction> {
    const model = this.genAI.models;
    const pageUrl = this.page.url();
    const pageTitle = await this.page.title().catch(() => "Unknown");

    const prompt = `You are an autonomous browser agent. Your objective is: "${objective}"

Current state:
- URL: ${pageUrl}
- Page title: ${pageTitle}
- Step: ${this.stepCount}/${this.maxSteps}
- Previous logs: ${this.logs.slice(-5).join("\n")}

Analyze the screenshot and decide the next action. Return a JSON object:
{
  "action": "CLICK|TYPE|SCROLL|WAIT|FINISH|GOTO|HOVER|PRESS_KEY",
  "selector": "CSS selector (for CLICK, TYPE, HOVER)",
  "text": "text to type (for TYPE)",
  "url": "URL (for GOTO)",
  "key": "key name (for PRESS_KEY: Enter, Tab, Escape, etc.)",
  "scrollX": 0,
  "scrollY": 300,
  "reason": "why you're doing this action"
}

If the objective is complete, use FINISH action.
Prefer specific CSS selectors. For forms, use [name="..."] or [type="..."] or [placeholder="..."].`;

    const response = await model.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: screenshot } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 512,
      },
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{"action":"WAIT","reason":"Unable to parse response"}';
    
    try {
      return JSON.parse(text);
    } catch {
      return { action: "WAIT", reason: "Parse error, waiting..." };
    }
  }

  private async executeAction(action: AgentAction): Promise<void> {
    this.log(`Action: ${action.action} — ${action.reason}`, "info");

    switch (action.action) {
      case "GOTO":
        await this.page.goto(action.url || "about:blank", { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(randomBetween(500, 1500));
        break;

      case "CLICK":
        await this.humanClick(action.selector!);
        await sleep(randomBetween(300, 800));
        break;

      case "TYPE":
        await this.humanType(action.selector!, action.text || "");
        await sleep(randomBetween(200, 500));
        break;

      case "SCROLL":
        await this.humanScroll(action.scrollX || 0, action.scrollY || 300);
        await sleep(randomBetween(200, 400));
        break;

      case "HOVER":
        await this.page.hover(action.selector!, { timeout: 5000 });
        await sleep(randomBetween(300, 700));
        break;

      case "PRESS_KEY":
        await this.page.keyboard.press(action.key || "Enter");
        await sleep(randomBetween(200, 500));
        break;

      case "WAIT":
        await sleep(randomBetween(1000, 3000));
        break;

      case "FINISH":
        this.log("Task completed successfully!", "success");
        break;

      case "SCREENSHOT":
        const ss = await this.takeScreenshot();
        this.options.onScreenshot?.(ss);
        break;
    }
  }

  async run(): Promise<{ success: boolean; logs: string[]; summary: string }> {
    try {
      await this.initialize();

      this.log(`Starting task: ${this.options.prompt}`, "info");

      let lastAction: AgentAction | null = null;

      while (this.stepCount < this.maxSteps) {
        this.stepCount++;
        this.log(`Step ${this.stepCount}/${this.maxSteps}`, "info");

        // Take screenshot for AI vision
        const screenshot = await this.takeScreenshot();
        this.options.onScreenshot?.(screenshot);

        // Get AI decision
        let action: AgentAction;
        try {
          action = await this.decideNextAction(screenshot, this.options.prompt);
        } catch (err: any) {
          this.log(`AI error: ${err.message}`, "error");
          await sleep(2000);
          continue;
        }

        // Check for completion
        if (action.action === "FINISH") {
          await this.executeAction(action);
          break;
        }

        // Execute action with retry
        try {
          await this.executeAction(action);
          lastAction = action;
        } catch (err: any) {
          this.log(`Action failed: ${err.message}`, "warning");
          // Try scrolling to make elements visible
          if (action.selector) {
            try {
              await this.page.evaluate((sel) => {
                document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }, action.selector);
              await sleep(500);
              await this.executeAction(action);
            } catch {
              this.log("Retry also failed, continuing...", "warning");
            }
          }
        }

        // Random human-like pause between actions
        await sleep(randomBetween(400, 1200));
      }

      const summary = this.logs.slice(-3).join(" | ");
      this.log("Agent run complete", "success");
      return { success: true, logs: this.logs, summary };

    } catch (err: any) {
      this.log(`Fatal error: ${err.message}`, "error");
      return { success: false, logs: this.logs, summary: `Error: ${err.message}` };
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.browser) await this.browser.close();
      this.log("Browser closed", "info");
    } catch {
      // Ignore cleanup errors
    }
  }

  getLogs(): string[] {
    return this.logs;
  }
}
