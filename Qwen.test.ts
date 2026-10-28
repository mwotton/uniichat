import { expect, test } from "bun:test";
import { qwen_body, QWEN_MODEL } from "./Qwen.ts";
import { OpenAI } from "./OpenAI.ts";
import { Pick } from "./Pick.ts";

test("Qwen routes locally without sending subscription credentials", async () => {
  const ask: any = { model: QWEN_MODEL };
  expect(typeof OpenAI.wire.url === "function" && OpenAI.wire.url(ask)).toBe("http://127.0.0.1:18080/v1/responses");
  expect(await OpenAI.wire.headers("secret-token", ask)).toEqual({ "content-type": "application/json" });
  expect(Pick.model("openai-api", "qwen-flash-next")?.id).toBe(QWEN_MODEL);
});

test("Qwen keeps function tools and limits output to local context budget", () => {
  const tool = { type: "function", name: "read", parameters: { type: "object" } };
  const out = qwen_body({
    max_output_tokens: 128000, tools: [tool, { type: "web_search" }],
    reasoning: { effort: "low", context: "all_turns" },
    service_tier: "default", prompt_cache_options: {}, max_tool_calls: 10,
    input: [{ role: "user", content: [{ type: "input_text", text: "Hi", prompt_cache_breakpoint: {} }] }],
  });
  expect(out.max_output_tokens).toBe(8192);
  expect(out.tools).toEqual([tool]);
  expect(out.reasoning).toEqual({ effort: "low" });
  expect(out).not.toHaveProperty("service_tier");
  expect(out.input[0].content[0]).not.toHaveProperty("prompt_cache_breakpoint");
});
