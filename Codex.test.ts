import { expect, test } from "bun:test";
import { codex_body } from "./Codex.ts";
import { OpenAI } from "./OpenAI.ts";

test("subscription requests preserve tool results and remove API-only fields", () => {
  const input = [
    { role: "developer", content: [{ type: "input_text", text: "System instructions" }] },
    { role: "user", content: [{ type: "input_text", text: "Hello", prompt_cache_breakpoint: { mode: "explicit" } }] },
    { type: "function_call_output", call_id: "test", output: [{ type: "input_text", text: "Result" }] },
  ];
  const out = codex_body({
    model: "gpt-6.1-sol", input, stream: true, store: false,
    reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
    max_output_tokens: 100, max_tool_calls: 10, service_tier: "default",
    prompt_cache_options: { mode: "explicit" },
  });
  expect(out.instructions).toBe("System instructions");
  expect(out.input[0].content).toEqual([{ type: "input_text", text: "Hello" }]);
  expect(out.input[1]).toEqual(input[2]);
  expect(out.reasoning).toEqual({ effort: "medium", summary: "auto" });
  expect(out.include).toEqual(["reasoning.encrypted_content"]);
  expect(out).not.toHaveProperty("max_output_tokens");
  expect(out).not.toHaveProperty("service_tier");
  expect(input[1].content[0]).toHaveProperty("prompt_cache_breakpoint");
});

test("Codex streams retain replies and tool calls when final output is empty", () => {
  const ask: any = { speed: "slow" };
  const st = OpenAI.wire.start(ask);
  const reply = { type: "message", content: [{ type: "output_text", text: "Hello" }] };
  const tool = { type: "function_call", call_id: "call_test", name: "read", arguments: '{"path":"a"}' };
  OpenAI.read(st, { type: "response.output_item.done", output_index: 1, item: tool }, () => {});
  OpenAI.read(st, { type: "response.output_item.done", output_index: 0, item: reply }, () => {});
  OpenAI.read(st, { type: "response.completed", response: { status: "completed", output: [] } }, () => {});
  const step = OpenAI.step(st, ask);
  expect(step.out).toEqual([reply, tool]);
  expect(step.entries[0].text).toBe("Hello");
  expect(step.uses).toEqual([{ id: "call_test", name: "read", input: { path: "a" } }]);
  expect(step.stop).toBe("tools");
});
