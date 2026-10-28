// The existing local Strata server exposes the Responses API. It supports
// function tools, but not OpenAI's hosted web search or cache controls.
export const QWEN_MODEL = "qwen3.8-flash-next-iq3_s";

export function qwen_body(body: any): any {
  const { service_tier, prompt_cache_options, max_tool_calls, ...out } = body;
  out.max_output_tokens = Math.min(body.max_output_tokens, 8192);
  out.tools = body.tools.filter((tool: any) => tool.type === "function");
  const { context, ...reasoning } = body.reasoning;
  out.reasoning = reasoning;
  out.input = body.input.map((item: any) => {
    if (!Array.isArray(item.content)) return item;
    return { ...item, content: item.content.map(({ prompt_cache_breakpoint, ...part }: any) => part) };
  });
  return out;
}
