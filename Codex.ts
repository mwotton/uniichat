// Local subscription adapter. Codex owns login and refresh; credentials are
// read from its auth file for every request and never copied into UniiChat.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
let refreshing: Promise<void> | undefined;

function refresh(): Promise<void> {
  return refreshing ??= new Promise<void>((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Codex login refresh timed out")), 30000);
    function finish(error?: Error) {
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve();
    }
    child.on("error", finish);
    child.on("exit", () => finish(new Error("Codex exited before refreshing login")));
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error("Codex initialization failed"));
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: true } }) + "\n");
        }
        if (msg.id === 2) {
          finish(msg.error ? new Error("Codex refresh failed; run codex login") : undefined);
        }
      }
    });
    child.stdin.write(JSON.stringify({
      id: 1, method: "initialize", params: { clientInfo: { name: "uniichat", version: "local" } },
    }) + "\n");
  }).finally(() => { refreshing = undefined; });
}

export async function codex_headers(): Promise<Record<string, string>> {
  const path = (process.env.CODEX_HOME ?? homedir() + "/.codex") + "/auth.json";
  let auth = JSON.parse(await readFile(path, "utf8"));
  const token = auth.tokens?.access_token;
  if (auth.auth_mode !== "chatgpt" || !token) throw new Error("Run codex login with your ChatGPT subscription");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  if (claims.exp * 1000 < Date.now() + 300000) {
    await refresh();
    auth = JSON.parse(await readFile(path, "utf8"));
  }
  return {
    authorization: "Bearer " + auth.tokens.access_token,
    "chatgpt-account-id": auth.tokens.account_id,
    "content-type": "application/json",
    accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
}

export function codex_body(body: any): any {
  const { max_output_tokens, max_tool_calls, service_tier, prompt_cache_options, ...out } = body;
  out.instructions = body.input[0].content.map((part: any) => part.text ?? "").join("\n");
  out.input = body.input.slice(1).map((item: any) => {
    if (!Array.isArray(item.content)) return item;
    return { ...item, content: item.content.map(({ prompt_cache_breakpoint, ...part }: any) => part) };
  });
  const { context, ...reasoning } = out.reasoning;
  out.reasoning = reasoning;
  out.include = ["reasoning.encrypted_content"];
  return out;
}
