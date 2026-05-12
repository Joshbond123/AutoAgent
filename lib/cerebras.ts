/**
 * AutoAgent Pro — Cerebras AI Client
 * Models: llama-3.3-70b (primary), llama3.1-8b (fallback)
 * API:    OpenAI-compatible endpoint at https://api.cerebras.ai/v1
 * Ref:    https://inference-docs.cerebras.ai/resources/openai
 * Supports: unlimited key rotation, automatic failover, JSON mode
 */

const CEREBRAS_BASE = "https://api.cerebras.ai/v1";

export interface CerebrasMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CerebrasResponse {
  id: string;
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

export class CerebrasClient {
  private keys: string[];
  private currentIndex: number = 0;
  private failedKeys: Set<string> = new Set();

  constructor(keys: string[]) {
    if (!keys || keys.length === 0) {
      throw new Error("At least one Cerebras API key is required");
    }
    this.keys = keys.filter(k => k?.trim());
  }

  private nextKey(): string {
    const available = this.keys.filter(k => !this.failedKeys.has(k));
    if (available.length === 0) {
      // Reset failed keys and retry
      this.failedKeys.clear();
      return this.keys[this.currentIndex % this.keys.length];
    }
    const key = available[this.currentIndex % available.length];
    this.currentIndex = (this.currentIndex + 1) % available.length;
    return key;
  }

  async chat(
    messages: CerebrasMessage[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      jsonMode?: boolean;
    } = {}
  ): Promise<string> {
    // llama-3.3-70b — best tool-call + structured output support on Cerebras
    const model = options.model || "llama-3.3-70b";
    const maxRetries = Math.min(this.keys.length + 1, 5);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const apiKey = this.nextKey();

      try {
        const body: Record<string, unknown> = {
          model,
          messages: options.systemPrompt
            ? [{ role: "system", content: options.systemPrompt }, ...messages]
            : messages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 2048,
          stream: false,
        };

        if (options.jsonMode) {
          body.response_format = { type: "json_object" };
        }

        const res = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (res.status === 401 || res.status === 403) {
          this.failedKeys.add(apiKey);
          console.warn(`[Cerebras] Key rejected (${res.status}), rotating to next key...`);
          continue;
        }

        if (res.status === 429) {
          console.warn(`[Cerebras] Rate limited on key ${apiKey.slice(-6)}, rotating...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Cerebras API error ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data: CerebrasResponse = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("Empty response from Cerebras");

        return content;

      } catch (err: any) {
        if (attempt === maxRetries - 1) throw err;
        console.warn(`[Cerebras] Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    throw new Error("All Cerebras API keys exhausted or failed");
  }

  async chatJSON<T>(messages: CerebrasMessage[], options = {}): Promise<T> {
    const text = await this.chat(messages, { ...options, jsonMode: true });
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ||
                        text.match(/```\s*([\s\S]*?)\s*```/) ||
                        [null, text];
      return JSON.parse(jsonMatch[1] || text) as T;
    } catch {
      throw new Error(`Failed to parse Cerebras JSON response: ${text.substring(0, 200)}`);
    }
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get activeKeys(): number {
    return this.keys.filter(k => !this.failedKeys.has(k)).length;
  }
}

/**
 * Create a CerebrasClient from a comma-separated key string or array.
 */
export function createCerebrasClient(keysInput: string | string[]): CerebrasClient {
  const keys = Array.isArray(keysInput)
    ? keysInput
    : keysInput.split(",").map(k => k.trim()).filter(Boolean);
  return new CerebrasClient(keys);
}
