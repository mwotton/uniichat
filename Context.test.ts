import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const root = fs.mkdtempSync(os.tmpdir() + "/unii-context-");
process.env.UNII_DIR = root;
process.env.UNII_CONTEXT_LIMITS = JSON.stringify({
  "qwen3.8-flash-next-iq3_s": { context: 12000, output: 1000, margin: 500 },
});
process.env.OPENAI_API_KEY = "fake-context-test";
const { Agent } = await import("./Agent.ts");
const { AskAI } = await import("./AskAI.ts");
const { Memory } = await import("./Memory.ts");
const { Context } = await import("./Context.ts");
const { ContextView } = await import("./ContextView.ts");
const { OpenAI } = await import("./OpenAI.ts");
const { Tools } = await import("./Tools.ts");
const wire = { ...OpenAI.wire };
const originalAsk = AskAI.ask;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((close) => close());
  Object.assign(OpenAI.wire, wire);
  AskAI.ask = originalAsk;
});

const pick = { vendor: "openai-api" as const, model: "qwen3.8-flash-next-iq3_s", effort: "low", speed: "slow" };
const share = () => ({ ...pick, system: "Complete the task.", searches: 0, server: "" });

function memory() {
  // Deterministic fake compactor; the real tree scheduling/storage still runs.
  AskAI.ask = ((ask: any) => ({
    done: Promise.resolve({ ok: true, text: "summary: " + ask.blocks.at(-1).text.slice(-80), left: [] }),
    send() {}, stop() {}, move() {},
  })) as any;
  const mem = Memory.load(fs.mkdtempSync(root + "/memory-"), share);
  cleanups.push(() => Memory.stop(mem));
  return mem;
}

function sse(output: object[], failed?: object) {
  const response = failed ? { status: "failed", error: failed, output: [] } : {
    status: "completed", output, usage: { input_tokens: 100, output_tokens: 50 },
  };
  return new Response("data: " + JSON.stringify({ type: failed ? "response.failed" : "response.completed", response }) + "\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

async function exercise(options: {
  rounds?: number;
  rejection?: "http" | "stream" | "quota" | "always";
  pending?: boolean;
  cancel?: boolean;
  late?: boolean;
  history?: boolean;
  exact?: boolean;
} = {}) {
  const mem = memory();
  if (options.history) Memory.push(mem, Array.from({ length: 12 }, () => ({ kind: "echo" as const, text: "Older model history " + "h".repeat(2000) })));
  const from = mem.count;
  Memory.push(mem, [{ kind: "user", text: "Finish the task; preserve the constraint NEVER DELETE." }]);
  const bodies: any[] = [];
  let executions = 0, rebuilds = 0, rejected = false;
  let call: ReturnType<typeof Agent.ask>;
  const mcp = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const msg: any = await req.json();
    let result: any;
    if (msg.method === "tools/list") {
      result = { tools: [{ name: "work", description: "Work once", inputSchema: { type: "object", properties: {} } }] };
    } else if (msg.method === "tools/call") {
      executions++;
      result = { content: [{ type: "text", text: "tool-result-" + executions + " " + "x".repeat(3500) }] };
    } else if (msg.method === "context/rebuild") {
      rebuilds++;
      if (options.cancel) {
        call.stop();
        return Response.json({ result: {} });
      }
      if (options.pending && rebuilds === 1) {
        const [entry] = Memory.push(mem, [{ kind: "user", text: "NEW CONSTRAINT: preserve backups." }]);
        call.send({ text: entry.text, imgs: [], at: entry.i });
      }
      result = await ContextView.build(mem, msg.params.from, mem.count, msg.params.target, req.signal);
      if (options.late && rebuilds === 1) {
        const [entry] = Memory.push(mem, [{ kind: "user", text: "LATE CONSTRAINT: keep the archive." }]);
        call.send({ text: entry.text, imgs: [], at: entry.i });
      }
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  } });
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body: any = await req.json();
    bodies.push(body);
    const shouldReject = executions >= 2 && (!rejected || options.rejection === "always");
    if (options.rejection && shouldReject) {
      rejected = true;
      if (options.rejection === "stream") return sse([], { code: "context_length_exceeded", message: "Too long" });
      return Response.json({ error: { message: options.rejection === "quota" ? "credit balance is too low" :
        "request exceeds the context window: prompt too long" } }, { status: 400 });
    }
    if (executions < (options.rounds ?? 9)) return sse([{
      type: "function_call", call_id: "work-" + executions, name: "work", arguments: "{}",
    }]);
    return sse([{ type: "message", content: [{ type: "output_text", text: "Finished." }] }]);
  } });
  cleanups.push(() => mcp.stop(true), () => provider.stop(true));
  OpenAI.wire.url = "http://127.0.0.1:" + provider.port;
  OpenAI.wire.headers = () => ({ "content-type": "application/json" });
  if (options.exact) OpenAI.wire.count = async () => 100;
  call = Agent.ask({
    ...share(), blocks: [{ text: Array.from({ length: mem.count }, (_, i) => Memory.message(mem, i)!.text).join("\n"), mark: true }],
    server: "http://127.0.0.1:" + mcp.port, context: { from },
  }, (ev) => {
    if (ev.$ === "Entry" && !["mind", "user"].includes(ev.kind)) Memory.push(mem, [{ kind: ev.kind, text: ev.text }]);
  });
  const end = await call.done;
  return { end, bodies, executions, rebuilds, mem };
}

test("long tool runs rebuild repeatedly and completed tools execute exactly once", async () => {
  const x = await exercise();
  expect(x.end.ok).toBe(true);
  expect(x.executions).toBe(9);
  expect(x.rebuilds).toBeGreaterThanOrEqual(2);
  expect(x.bodies.every((b) => Context.estimate(b) <= 10500)).toBe(true);
  expect(x.bodies.every((b) => b.max_output_tokens === 1000)).toBe(true);
  const last = JSON.stringify(x.bodies.at(-1));
  expect(last).toContain("NEVER DELETE");
  expect(last).toContain("tool-result-9");
  for (const body of x.bodies) {
    const calls = new Set(body.input.filter((i: any) => i.type === "function_call").map((i: any) => i.call_id));
    for (const back of body.input.filter((i: any) => i.type === "function_call_output")) expect(calls.has(back.call_id)).toBe(true);
  }
  expect(Array.from({ length: x.mem.count }, (_, i) => Memory.message(x.mem, i)!.text).join("\n")).toContain("tool-result-1");
});

for (const rejection of ["http", "stream"] as const) test(rejection + " context errors recover automatically", async () => {
  const x = await exercise({ rejection, rounds: 3 });
  expect(x.end.ok).toBe(true);
  expect(x.executions).toBe(3);
  expect(x.rebuilds).toBeGreaterThan(0);
});

test("quota errors are not retried as context errors", async () => {
  const x = await exercise({ rejection: "quota" });
  expect(x.end.ok).toBe(false);
  expect(x.rebuilds).toBe(0);
  expect(x.bodies.length).toBe(3);
});

test("repeated context errors stop instead of looping forever", async () => {
  const x = await exercise({ rejection: "always" });
  expect(x.end.ok).toBe(false);
  expect(x.rebuilds).toBeLessThanOrEqual(2);
  expect(x.executions).toBe(2);
});

test("a queued message covered by the snapshot appears once and leaves no pending copy", async () => {
  const x = await exercise({ pending: true });
  expect(x.end.ok).toBe(true);
  const text = JSON.stringify(x.bodies.at(-1));
  expect(text.match(/NEW CONSTRAINT/g)?.length).toBe(1);
  expect(x.end.left).toEqual([]);
});

test("a message after the snapshot stays queued and is delivered once", async () => {
  const x = await exercise({ late: true });
  expect(x.end.ok).toBe(true);
  expect(JSON.stringify(x.bodies.at(-1)).match(/LATE CONSTRAINT/g)?.length).toBe(1);
  expect(x.end.left).toEqual([]);
});

test("switching a wide saved history to a smaller model rebuilds before its first request", async () => {
  const x = await exercise({ history: true, rounds: 0 });
  expect(x.end.ok).toBe(true);
  expect(x.rebuilds).toBe(1);
  expect(Context.estimate(x.bodies[0])).toBeLessThan(10500);
  expect(JSON.stringify(x.bodies[0])).toContain("NEVER DELETE");
});

test("an exact provider count supersedes the conservative estimate", async () => {
  const x = await exercise({ exact: true });
  expect(x.end.ok).toBe(true);
  expect(x.rebuilds).toBe(0);
  expect(Context.estimate(x.bodies.at(-1))).toBeGreaterThan(10500);
});

test("cancellation during rebuild stops before the next request or tool", async () => {
  const x = await exercise({ cancel: true });
  expect(x.end.ok).toBe(false);
  expect(x.executions).toBe(3);
  expect(x.bodies.length).toBe(3);
  expect(x.rebuilds).toBe(1);
});

test("an oversized user request fails clearly without truncating it", async () => {
  const ask = { ...share(), blocks: [{ text: "u".repeat(20000), mark: false }], server: "" };
  const end = await Agent.ask(ask, () => {}).done;
  expect(end.ok).toBe(false);
  expect(end.text).toContain("context budget");
  expect(ask.blocks[0].text.length).toBe(20000);
});

test("unbuilt summaries keep original messages and waiting is cancellable", async () => {
  const mem = memory();
  mem.done = true;
  Memory.push(mem, [{ kind: "user", text: "Keep the task" }, ...Array.from({ length: 10 }, () => ({ kind: "echo" as const, text: "unsummarized".repeat(200) }))]);
  const controller = new AbortController();
  const waiting = ContextView.build(mem, 0, mem.count, 500, controller.signal);
  controller.abort(new Error("test cancelled"));
  expect(waiting).rejects.toThrow("test cancelled");
  expect(Memory.message(mem, 1)!.text).toContain("unsummarized");
});

test("subagent tree survives reopening and task zoom reaches its own originals", async () => {
  const mem = memory();
  const name = Memory.agent_new(mem);
  Memory.agent_push(mem, name, "note", "fixture");
  Memory.agent_push(mem, name, "user", "Agent task: keep MY CONSTRAINT");
  for (let i = 0; i < 12; i++) Memory.agent_push(mem, name, "echo", "own-result-" + i + " " + "x".repeat(1000));
  const tools = Tools.serve(mem, {} as any);
  const agent: any = { name, role: { $: "sub", effort: null }, view: [], call: null, replies: [], live: [], calls: {}, stop: false };
  tools.agents.set(name, agent);
  cleanups.push(() => Tools.close(tools));
  const frame = await Tools.context(tools, name, 0, 4000, new AbortController().signal);
  expect(JSON.stringify(frame)).toContain("MY CONSTRAINT");
  expect(JSON.stringify(frame)).toContain("task_history");
  expect(frame.through).toBe(14);
  const zoom = await Tools.call(tools, name, "zoom", { id: 2, n: 1, scope: "task" }, new AbortController().signal, "test");
  expect(zoom.text).toContain("own-result-0");
  Tools.close(tools);
  const tools2 = Tools.serve(mem, {} as any);
  tools2.agents.set(name, agent);
  cleanups.push(() => Tools.close(tools2));
  const reopened = await Tools.context(tools2, name, 0, 4000, new AbortController().signal);
  expect(reopened.through).toBe(14);
  expect(JSON.stringify(reopened)).toContain("MY CONSTRAINT");
});

test("the main rebuild waits for pending log writes and refreshes the active goal", async () => {
  const mem = memory();
  Memory.push(mem, [{ kind: "user", text: "Initial task" }]);
  mem.goal = "Keep working until verified";
  const tools = Tools.serve(mem, {
    flush: async () => { Memory.push(mem, [{ kind: "user", text: "Instruction committed by a pending post" }]); },
  } as any);
  cleanups.push(() => Tools.close(tools));
  const frame = await Tools.context(tools, "main", 0, 4000, new AbortController().signal);
  expect(frame.through).toBe(2);
  expect(JSON.stringify(frame)).toContain("Instruction committed by a pending post");
  expect(JSON.stringify(frame)).toContain("Keep working until verified");
});

test("image data is budgeted as images and Unicode bytes count fully", () => {
  expect(Context.estimate({ text: "漢".repeat(1000) })).toBeGreaterThan(3000);
  expect(Context.estimate({ image_url: "data:image/png;base64," + "x".repeat(100000) })).toBeLessThan(17000);
  expect(Context.overflow("invalid authentication token")).toBe(false);
  expect(Context.estimate({ data: "x".repeat(20000) })).toBeGreaterThan(20000);
});

test("latest tool images survive replacing the native history", async () => {
  const image = { type: "image/png", data: "cGlj" };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () =>
    Response.json({ result: { blocks: [{ text: "Shorter history", mark: true }], through: 1 } }) });
  cleanups.push(() => server.stop(true));
  const run: any = {
    ask: { ...share(), context: { from: 0 }, server: "http://127.0.0.1:" + server.port },
    on() {}, sent: [], abort: new AbortController(), end: AskAI.end(""), latest: [image],
  };
  const items: any[] = [{ $: "User", parts: [{ text: "x".repeat(20000), mark: false }], imgs: [image] }];
  expect(await Agent.rebuild(run, items, 5000, 40000, "budget")).toBe(true);
  expect(items[0].imgs).toEqual([image]);
});
