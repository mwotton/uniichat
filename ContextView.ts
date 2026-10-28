// A request-specific view. Never mutates the shared view or discards a record.
// Recent records and the task's user instructions stay verbatim. Older ranges
// use existing tree parents; missing summaries fall back to original messages.
import { Memory } from "./Memory.ts";
import type { Block } from "./AskAI.ts";
import type { Frame } from "./Context.ts";

type Part = { l: number; i: number };

export namespace ContextView {
  export async function build(mem: Memory, from: number, end: number, target: number, signal: AbortSignal, scope: "chat" | "task" = "chat"): Promise<Frame> {
    let recent = Math.max(0, end - 6);
    // Include a result's call and all pages of its message in the verbatim tail.
    while (recent > 0 && (Memory.message(mem, recent - 1)?.more || Memory.message(mem, recent)?.kind === "echo")) recent--;
    const pinned: number[] = [];
    for (let i = from; i < end; i++) {
      if (["user", "work"].includes(Memory.message(mem, i)!.kind)) pinned.push(i);
    }
    const pins = new Set(pinned);
    const raw = (i: number) => i + "+1|" + Memory.show(Memory.message(mem, i)!) + "\n";
    const text = (p: Part) => p.l === 0 && pins.has(p.i) ? raw(p.i) :
      Memory.node(mem, p) === null ? raw(p.i) : Memory.line(p, Memory.node(mem, p)!) + "\n";
    const cover = (p: Part): Part[] => {
      const [a, b] = Memory.span(p);
      if (p.l === 0 || (!pinned.some((i) => i >= a && i <= b) && Memory.node(mem, p) !== null)) return [p];
      return Memory.halves(p).flatMap(cover);
    };
    let tail = () => Array.from({ length: end - recent }, (_, k) => raw(recent + k)).join("");
    let parts = Memory.roots(recent).flatMap(cover);
    let size = () => Buffer.byteLength(parts.map(text).join("") + tail());
    // First try a shorter verbatim tail. If even the last tool exchange is
    // huge, its completed records may use summaries as well. User instructions
    // remain pinned at every size, and zoom still reaches every original.
    while (size() > target && recent < end) {
      recent = Math.min(end, recent + 2);
      while (recent < end && (Memory.message(mem, recent - 1)?.more || Memory.message(mem, recent)?.kind === "echo")) recent++;
      parts = Memory.roots(recent).flatMap(cover);
    }
    if (size() > target && Memory.first(mem) < end) {
      const why = await Memory.settle(mem, end, signal);
      if (signal.aborted) throw signal.reason;
      if (why !== null) throw new Error(why);
      parts = Memory.roots(recent).flatMap(cover);
    }
    if (signal.aborted) throw signal.reason;
    // Spend remaining space on detail, most recent ranges first. Coarsening
    // happens only when a request rebuilds, preserving cache between batches.
    for (let k = parts.length - 1; k >= 0; k--) {
      const p = parts[k];
      if (p.l === 0) continue;
      const halves = Memory.halves(p);
      if (halves.some((h) => Memory.node(mem, h) === null)) continue;
      const extra = Buffer.byteLength(halves.map(text).join("")) - Buffer.byteLength(text(p));
      if (size() + extra <= target) {
        parts.splice(k, 1, ...halves);
        k += 2;
      }
    }
    const lines = [...parts.map(text), tail()];
    const tag = scope === "task" ? "task_history" : "chat";
    const blocks: Block[] = [
      { text: "<" + tag + ">\n" + lines.join("") + "</" + tag + ">\n", mark: true },
      { text: "Continue the current task. Recent records above are verbatim; older id+n lines are memory summaries. Completed tools already ran: use their recorded results and do not repeat their effects. Use zoom" + (scope === "task" ? ' with scope="task"' : "") + " for older details.\n", mark: false },
    ];
    const images = [...new Set([...pinned, ...Array.from({ length: end - recent }, (_, k) => recent + k)])].flatMap((i) => Memory.images(mem, i));
    return { blocks, imgs: images, through: end };
  }
}
