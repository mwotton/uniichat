// Context budgets are operating limits, not advertised model specifications.
// Unknown models use a conservative 128K budget; operators can override by id.
import { config_get } from "./Config.ts";
import type { Img } from "./AskAI.ts";

export type Limits = { context: number; output: number; margin: number };
export type Frame = { blocks: import("./AskAI.ts").Block[]; imgs?: Img[]; through: number };

const DEFAULT: Limits = { context: 131072, output: 32768, margin: 4096 };
const LOCAL: Limits = { context: 65536, output: 8192, margin: 4096 };
const configured: unknown = config_get("context_limits", "{}");
const overrides = (typeof configured === "string" ? JSON.parse(configured) : configured) as Record<string, Partial<Limits>>;
if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("context_limits must be an object keyed by model id");

export namespace Context {
  export function limits(model: string): Limits {
    const base = model === "qwen3.8-flash-next-iq3_s" ? LOCAL : DEFAULT;
    const value = { ...base, ...overrides[model] };
    if (![value.context, value.output, value.margin].every((n) => Number.isSafeInteger(n) && n > 0)
        || value.output + value.margin >= value.context) {
      throw new Error("Invalid context limits for " + model);
    }
    return value;
  }

  // One token per UTF-8 byte is deliberately conservative for code, Unicode
  // and tool JSON. Base64 is replaced by an image allowance, not counted as text.
  // Vendor counters, when available, replace this estimate near the limit.
  export function estimate(body: unknown): number {
    let images = 0;
    const json = JSON.stringify(body, (key, value) => {
      if (value && typeof value === "object" && (
        value.type === "input_image" || value.type === "image_url" || (value.type === "image" && value.source) ||
        (typeof value.type === "string" && value.type.startsWith("image/") && typeof value.data === "string")
      )) {
        images += 16384;
        return { type: value.type, image: "[image]" };
      }
      if (typeof value === "string" && value.startsWith("data:image/")) {
        images += 16384;
        return "[image]";
      }
      return value;
    });
    return Buffer.byteLength(json) + images;
  }

  export function overflow(text: string): boolean {
    return /context_length_exceeded|maximum context length|exceeds? (?:the )?context (?:window|length)|prompt (?:is )?too long|too many (?:input )?tokens/i.test(text);
  }
}
