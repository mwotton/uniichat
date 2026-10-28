# Automatic context management

The binary summary tree is the backing store. A model request is a bounded
view over it. Long tool sessions periodically rebuild that view rather than
waiting for the user to recover from a context-window error.

## Budgets

`context_limits` in config.json accepts overrides by provider model ID:

```json
{
  "context_limits": {
    "qwen3.8-flash-next-iq3_s": {
      "context": 65536,
      "output": 8192,
      "margin": 4096
    }
  }
}
```

The equivalent environment setting is a JSON object:

```sh
export UNII_CONTEXT_LIMITS='{"qwen3.8-flash-next-iq3_s":{"context":65536,"output":8192,"margin":4096}}'
```

Qwen defaults to those numbers. Other models use an operating budget of
131,072 total, 32,768 output, and 4,096 margin. These deliberately conservative
defaults are not claims about the models' advertised capacities. Override
them for your actual deployment. All values must be positive integers and
output plus margin must be smaller than context.

The maximum input is context minus output minus margin. Every request checks
system instructions, tools, history and images. Text is estimated at one
token per UTF-8 byte, and each image gets a 16,384-token allowance. Anthropic's
counter replaces the estimate near the limit. The current OpenAI/Strata
Responses adapter has no exact counter, so English/code often rebuilds early.
The estimate is a guardrail, not a tokenizer guarantee; explicit provider
overflow recovery handles mismatches.

API output limits are capped at the configured output budget, including paid
booking. The Codex subscription endpoint does not accept max_output_tokens:
its adapter removes that field, as before. Output reserve there is an input
budgeting policy, not an enforced generation cap.

## Rebuilding

Rebuilds happen before model requests, once all tools from the previous
response have completed and their entries have been logged. The owning
server flushes pending log writes, then fixes a transcript end for the
snapshot. Later messages remain queued; messages already covered are not
appended twice.

The request-specific view starts from existing summary parents. It spends
remaining space on newer detail, with up to six recent records verbatim.
If a tool exchange is too large, that completed exchange can use summaries
too. User instructions and agent reports in the current task stay verbatim.
Missing summaries retain their original text; when needed, the rebuild waits
for summaries with a 30-second cancellation bound. An irreducible task gets
a clear failure instead of silently truncating it.

The new input contains author-tagged transcript text. All old native tool
and reasoning items are removed together, so no unmatched tool results or
provider reasoning sequences remain. The loop does not dispatch completed
tools again. It instructs the model to continue from their recorded results.
This does not make arbitrary shell operations idempotent or prevent a model
from independently choosing to repeat an action.

Active goal, current devices and background agent state are refreshed.
The latest image-producing tool result is carried through rebuilds, because
the upstream agent log stores tool entries as text. User images remain
attached when their messages are retained verbatim. Earlier tool images
are not recoverable from that text log; this predates the fork.

The internal rebuild RPC follows chat ownership across worker moves.
Subagent summaries are cached in `docs/agent/<name>.memory` beside the original
agent JSONL log and reused after restarts. Their IDs belong to task history:
use `zoom(id, n, scope: "task")`; ordinary `zoom` still reads the shared chat.
The inherited shared-chat view is also retained in a smaller form.

## Recovery and observability

Explicit context-limit HTTP errors and streamed failures trigger at most two
smaller rebuilds per rejected request. Every attempt must shrink the input;
otherwise recovery stops. Other HTTP 400 errors, authentication failures and
quota failures retain their existing behavior.

The UI shows a rebuilding status. The server logs `context:` JSON with model,
trigger, input size before rebuilding, estimated history size before/after,
target and snapshot boundary. Normal
requests keep their existing input prefix; rebuilding is batched rather than
rewriting the tree view after every tool call.

Original main and agent logs are retained. The existing tool-output clipping
and summary refusal fallback still apply: `zoom` cannot recover text already
clipped before it was logged.

## Validation

`bun test --isolate --timeout 15000` exercises the original suite and fake
provider regressions for long tool runs, HTTP and streamed overflow recovery,
bounded failure, quota errors, queued messages, cancellation, missing
summaries, subagent restart/zoom, Unicode and image budgeting.
