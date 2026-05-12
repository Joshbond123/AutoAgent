import playwright, { Page, BrowserContext } from "playwright";
import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import CryptoJS from "crypto-js";

interface AgentAction {
  action: "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "FINISH" | "GOTO";
  selector?: string;
  text?: string;
  reason: string;
}

export class AutonomousAgent {
  private page!: Page;
  private context!: BrowserContext;
  private browser!: playwright.Browser;
  private genAI: any;
  private logs: string[] = [];
  private onLog?: (msg: string, type: string) => void;

  constructor(private apiKey: string, private cerebrasKeys: string[] = []) {
    this.genAI = new GoogleGenAI({ apiKey: this.apiKey });
  }

  setLogCallback(cb: (msg: string, type: string) => void) {
    this.onLog = cb;
  }

  private log(msg: string, type: string = "info") {
    this.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (this.onLog) this.onLog(msg, type);
  }

  async initialize(options: { headless?: boolean; proxy?: string; profilePath?: string } = {}) {
    this.log("Launching browser...", "info");
    this.browser = await playwright.chromium.launch({
      headless: options.headless ?? true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    });

    // Human-like: stealth
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    this.page = await this.context.newPage();
  }

  async run(objective: string) {
    this.log(`Objective: ${objective}`, "info");
    let stepCount = 0;
    const maxSteps = 20;

    while (stepCount < maxSteps) {
      stepCount++;
      this.log(`Step ${stepCount}: Analyzing page...`, "info");

      const state = await this.getPageStatus();
      const nextAction = await this.getAIPrediction(objective, state);

      this.log(`AI Reasoning: ${nextAction.reason}`, "info");

      if (nextAction.action === "FINISH") {
        this.log("Objective reached!", "success");
        break;
      }

      await this.executeAction(nextAction);
      
      // Random delay for human-like behavior
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    if (stepCount >= maxSteps) {
      this.log("Max steps reached without finishing.", "error");
    }
  }

  private async getPageStatus() {
    const url = this.page.url();
    const title = await this.page.title();
    
    // Extract interactive elements to reduce token count
    const elements = await this.page.evaluate(() => {
      const interactives = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role='button']"));
      return interactives.map((el, index) => ({
        index,
        tag: el.tagName,
        text: (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "",
        id: el.id,
        className: el.className,
        type: (el as HTMLInputElement).type,
      })).filter(e => e.text || e.id);
    });

    return { url, title, elements: elements.slice(0, 50) }; // Limit elements for token safety
  }

  private cerebrasIndex = 0;

  private async getAIPrediction(objective: string, state: any): Promise<AgentAction> {
    const prompt = `
      You are an autonomous browser agent. Your objective is: "${objective}"
      Current URL: ${state.url}
      Page Title: ${state.title}
      
      Interactive Elements on page:
      ${JSON.stringify(state.elements, null, 2)}
      
      What is the next best action to take?
      Return a JSON object with: 
      - action: "GOTO" | "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "FINISH"
      - selector: (CSS selector or element index/text if applicable)
      - text: (text to type if action is TYPE)
      - reason: (brief explanation of why this action)
      
      If you are at the final result, use FINISH.
    `;

    // Try Cerebras if keys are available, otherwise fallback to Gemini
    if (this.cerebrasKeys.length > 0) {
      try {
        return await this.getCerebrasPrediction(prompt);
      } catch (err) {
        this.log("Cerebras failed, rotating or falling back to Gemini...", "warning");
        this.rotateCerebrasKey();
      }
    }

    const response = await this.genAI.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            action: { type: Type.STRING },
            selector: { type: Type.STRING },
            text: { type: Type.STRING },
            reason: { type: Type.STRING }
          },
          required: ["action", "reason"]
        }
      }
    });

    return JSON.parse(response.text);
  }

  private rotateCerebrasKey() {
    if (this.cerebrasKeys.length > 0) {
      this.cerebrasIndex = (this.cerebrasIndex + 1) % this.cerebrasKeys.length;
    }
  }

  private async getCerebrasPrediction(prompt: string): Promise<AgentAction> {
    const key = this.cerebrasKeys[this.cerebrasIndex];
    // This is a placeholder for the real Cerebras API call (OpenAI compatible)
    const response = await axios.post("https://api.cerebras.ai/v1/chat/completions", {
      model: "llama3.1-70b",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    }, {
      headers: { "Authorization": `Bearer ${key}` }
    });
    return response.data.choices[0].message.content;
  }

  private async solveCaptchaIfPresent() {
    const selector = "iframe[src*='recaptcha'], iframe[title*='hCaptcha'], .cf-turnstile";
    const captcha = await this.page.$(selector);
    if (captcha && process.env.NOPECHA_API_KEY) {
      this.log("CAPTCHA detected, attempting to solve via NopeCHA...", "warning");
      // NopeCHA automation logic would go here
      // For extensions, we'd load it in initialize()
    }
  }

  private async executeAction(action: AgentAction) {
    this.log(`Executing ${action.action}...`, "info");
    
    try {
      switch (action.action) {
        case "GOTO":
          await this.page.goto(action.text || "");
          break;
        case "CLICK":
          if (action.selector) {
            await this.humanClick(action.selector);
          }
          break;
        case "TYPE":
          if (action.selector && action.text) {
            await this.humanType(action.selector, action.text);
          }
          break;
        case "SCROLL":
          await this.page.mouse.wheel(0, 500);
          break;
        case "WAIT":
          await new Promise(r => setTimeout(r, 5000));
          break;
      }
    } catch (err: any) {
      this.log(`Action failed: ${err.message}`, "error");
    }
  }

  private async humanClick(selector: string) {
    const el = await this.page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    const box = await el.boundingBox();
    if (box) {
      // Move mouse to center with some randomness
      await this.page.mouse.move(
        box.x + box.width / 2 + (Math.random() * 10 - 5),
        box.y + box.height / 2 + (Math.random() * 10 - 5),
        { steps: 10 }
      );
      await this.page.mouse.down();
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100)); // Click duration
      await this.page.mouse.up();
    } else {
      await el.click();
    }
  }

  private async humanType(selector: string, text: string) {
    await this.page.focus(selector);
    for (const char of text) {
      await this.page.keyboard.type(char, { delay: 50 + Math.random() * 150 });
    }
    await this.page.keyboard.press("Enter");
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}
