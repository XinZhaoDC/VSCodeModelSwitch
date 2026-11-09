# Model speed tests and AI queries

**Quick Speed Test** makes one fixed short request. **Standard Speed Test** makes
three serial requests. Each request uses model quota. Saving/applying a Provider,
opening the sidebar, and reading results never start a benchmark.

API Provider buttons test the saved connection/model, including its proxy settings,
without Apply. Official buttons use the active Codex account in an ephemeral
app-server thread, not the conversation currently on screen. Claude subscription
probing is not included; Claude API Providers are supported.

Official probes use the selected real/Sandbox Codex directory. An unauthenticated
Sandbox cannot borrow the real login. Set `vscodemodelswitch.codexExecutablePath`
if discovery cannot find the installed Codex extension or CLI.

## Metrics

Version 0.5.2 uses compact, matching **Network**, **Usage**, and **Speed** rows
for provider diagnostics and official speed results. There are no large metric
cards. Speed shows **Output** (generation rate), **TTFT** (first-text seconds),
**Overall** (end-to-end rate), successful sample count and an **estimated** label.
**tok/s** means tokens per second. Stale, failed, cancelled, mixed-condition and
buffered-stream states remain visible; unavailable rates show **N/A**.

One collapsed **Details** area holds full timestamps, model identifiers, network
endpoint/DNS, quota diagnostics and measurement explanations. This keeps the
normal sidebar compact without dropping diagnostic information.

- **First text / TTFT**: model request to first non-whitespace visible text.
  Initialization, headers, pings and reasoning summaries do not count.
- **Generation, estimated text tok/s**: local full-text token count minus the
  first arriving batch, divided by first-to-last visible-text time. Both counts
  are local estimates. A single batch, an interval below 1 ms, or a rebuilt proxy
  stream has no generation-rate result.
- **End-to-end, estimated text tok/s**: local visible-text token estimate divided
  by complete model-request time, including first-text wait.
- **Initialization**: Codex startup and thread preparation are separate. API
  measurements start at HTTP request and record no separate initialization.
- **Usage**: numeric server input/output/cache/reasoning counts remain separate;
  they can differ from visible text. Missing usage/tier stays unreported.

For actual work, compare **time to a correct completed task** on the same task and
acceptance criteria. Reading code, reasoning, tool execution, retries and correcting
mistakes all affect that time. A high text rate alone does not establish higher
productivity. End-to-end throughput is a useful reference for this short request's
wait experience; generation rate describes visible output after it starts.
First-text wait may include reasoning, queueing and network delay; this benchmark
does not isolate those components. These are fixed short-text probes, not live
monitoring of the working conversation or measurements of task success.

The local encoder is `o200k_base` for GPT-5+ / o-series names and `cl100k_base`
otherwise. This is an estimate, not a claim about an unknown model's or Claude's
actual tokenizer. Arrival-time measurements include network/proxy buffering and
cannot prove server-side generation timing. No instantaneous peak ranking is used.

Prompt `forest-sync-120-words-v1` asks for one plain English paragraph of about
120 words on forest robot sensor synchronization. API requests ask for at most
512 output tokens. Official Codex uses prompt length and a 120-second per-sample
timeout, not an API token cap. Official/Responses requests ask for low effort;
Anthropic/Chat Completions use provider defaults. Proxy parameter overrides, caps
and retry settings remain effective. `parameters.effort` is client-requested;
`connection.upstreamEffort` records a known proxy override. Unknown behavior is
not inferred.

Failed, incomplete, tool-using and cancelled samples are excluded from successful
aggregates and stop the remaining batch. Partial successes and failures are saved.
The selected proxy can still use its configured retry policy. Different reported
models, service tiers or measurement sources suppress combined medians. An
unreported tier does not prove that the tier stayed the same.

## AI queries

**Copy AI Speed Query** lives in the speed result's collapsed **Details** area
and remains available in the Command Palette. It first asks you to choose Codex
or Claude, then copies a read-only command for that tool's current Provider.
It does not select the history of the card containing the button. It does not
run a new benchmark or monitor the conversation.
Give it to an AI with terminal access, or run it in a Node.js terminal. Use a
POSIX shell or PowerShell on Windows.

```sh
node /path/to/installed-extension/out/speed/query.js --tool codex
node /path/to/installed-extension/out/speed/query.js --tool claude
```

The copied command includes the selected results directory explicitly. Normal
results are in `~/.vscodemodelswitch/speed/`: `reports/<id>.json` stores individual
batches and `current.json` stores the last target observed by the plugin.

Default queries require matching Provider, model and configuration revision.
`--provider-id ID` explicitly selects that Provider's history; `--model MODEL`
filters actual reported models; `--directory PATH` selects another directory.
These arguments never call a model or start the extension, Codex or a server.

JSON fields include:

- `status`: `fresh`, `stale`, `failed`, `cancelled`, `mixed`, `context-stale`, or
  `unavailable`. Freshness is 15 minutes and is recomputed for every query.
- `measurementStatus`, `ageSeconds`, `currentContextFresh`, time, sample counts,
  requested target, actual models, numeric usage and measurement sources.
- A reminder that this is a stored benchmark, not monitoring of the current chat.
  An old plugin target snapshot gives `context-stale`, even if the batch is recent.

An AI should state sample time and scope: “The latest three-run short benchmark
had a median first-text wait of … and estimated generation speed of …; it does
not measure this reply.” It should report missing/stale data explicitly. The AI
needs the command or an explicitly configured tool/instruction; this release does
not inject data into arbitrary AI clients, install MCP servers or change hooks.

Reports contain metrics, target identifiers and fixed parameters, not reply text,
credentials or account identifiers. Files belong to the extension host: a remote
container has its own results directory. They are not synced/exported as Providers.

## Validation and activation

```sh
npm run check
npm run test:speed
node scripts/test-proxy.js
node scripts/test-codex-proxy.js
node scripts/test-codex-modes.js
npm run package
```

Mock checks cover fragmented SSE, reasoning/usage, cancellation, missing terminal
events, buffering, model changes, target/freshness matching, standalone queries,
official sandbox selection, executable discovery and UI/controller dispatch.
Mocks do not prove all real gateways work. Set `VSCODEMODELSWITCH_TEST_HOME` to a
new task-local directory for proxy tests, preserving older fixtures.

Install the new VSIX and Reload Window to activate. Existing Providers require
no migration; the previous VSIX remains a rollback option.

References: [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
[Responses events](https://developers.openai.com/api/reference/resources/responses/streaming-events),
[Codex app-server](https://learn.chatgpt.com/docs/app-server).
