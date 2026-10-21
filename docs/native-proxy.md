# Native Claude proxy

Claude providers can use **Direct connection** or a **Built-in proxy**. The proxy
uses Node.js provided by the VS Code extension host; Python, Flask and external
proxy terminals are not required. Install/run the extension in the same
local/SSH/WSL/container environment as Claude Code.

The proxy's upstream transport uses the extension host's global `fetch`, the
same outbound path used by the plugin's Network/Models checks. This allows the
VS Code Server host-proxy route to be reused for relay calls, retries and web
tools. The local Claude endpoint remains loopback; only outbound upstream
requests use that host path.

HTTP upstreams use the byte-preserving Node HTTP path; HTTPS upstreams use the
extension-host fetch path. This keeps HTTP-only local/container relays stable
for large bodies while routing HTTPS relays through the VS Code Server host
proxy.

## Configure and apply

In Add Provider or an existing provider's **Config** editor, continue to enter
the actual upstream Base URL, API key and Model ID. Select **Built-in proxy**,
then **justdowork** or **Custom Anthropic**. The preset supplies defaults;
Advanced proxy settings stores only per-provider differences. Restore preset
defaults resets those differences in the unsaved form. Switching to Direct
retains the saved proxy settings for later use.

**Save does not Apply.** A previously applied provider whose configuration was
edited displays **Pending Apply**. Apply prepares the local route and writes a
disposable copy of the upstream template pointing to localhost, using a local
placeholder credential. Upstream templates and exported provider metadata keep
their original meaning. Restart an existing Claude client after applying new
settings. A failed client configuration write rolls back the staged route.

Each provider has an independent `/providers/<id>` endpoint. An in-flight
request uses a snapshot of its provider configuration. Switching to another
provider does not redirect existing clients' old endpoint to the new key.

## Status and lifecycle

**Active**, **Proxy Running**, and a successful model request are separate
states. A proxy can be running while the upstream returns 503. In that case
the SSE connection can have HTTP200 but carries an error; it is counted as a
failed request. Proxy Details shows the local endpoint, request counts,
retries, context omissions and the most recent request result. Log opens the
extension output channel; credentials and full prompts are not logged.

Stop aborts that route's active requests. Start/Restart resumes the last
applied route, not unapplied edits. If a route cannot be restored, Apply is
needed. Window reload attempts to recover the last applied port and snapshot
only when the client configuration still matches the managed endpoint. A
port conflict is reported rather than taking over another server. Apply can
establish a new endpoint; restart the client afterwards. Closing the VS Code
window stops the proxy, so external clients relying on it need that window
open. Multiple windows share CLI configuration files: the last explicit Apply
determines the endpoint used by newly started clients.

## Options

The justdowork preset maps Read/Write/Edit/Bash to the relay's lowercase names;
unmapped tools use a text-call protocol. The proxy repairs malformed tool JSON,
reconstructs the Anthropic stream with keepalive events, and caps historical
context/tool output with explicit omission markers. Native tool execution stays
in Claude Code. Optional WebSearch/WebFetch/fetch_image run inside the proxy.

Authentication modes are Bearer, x-api-key, both, or a custom header whose value
comes from the provider's SecretStorage key. Additional headers and parameters
must not contain credentials. Messages path defaults to `/v1/messages` and
supports providers whose Base URL includes an API prefix or terminal `/v1`.
Tool maps must be one-to-one. Additional parameters cannot replace routing,
messages, tools, system or stream fields. Presets never activate automatically
based on provider names or URLs.

By default the proxy follows the client's thinking configuration; it does not
add an invisible thinking budget. Extra thinking is opt-in for fresh user
turns. Client-requested thinking/signature blocks are retained. Output caps
must allow the selected thinking budget. System cache breakpoints are optional;
the proxy does not invent cache savings or subtract usage from billing totals.

History budgets are character budgets, not exact token counts. The original
instruction/current turn and native tool-result pairs are retained, even if a
single turn exceeds the budget. This proxy cannot guarantee that a very long
single prompt fits an upstream model. The count_tokens endpoint is approximate.

Custom Anthropic defaults to native tool schemas with no relay-specific
injection or web tools. Advanced users can add known mappings/headers/options.
Turning stream reconstruction off forwards native SSE and still checks error
and terminal events; text tool repair/mapping and server web tools require
reconstruction. It is not an OpenAI Responses/Anthropic protocol converter;
Codex providers continue to use their existing direct connection.

## Diagnostics and validation

Fetch Models and Network & Usage query the upstream. Verify Model uses the
provider's saved connection settings in a temporary route without changing the
already applied one. Claude verification requires an SSE answer of `OK` and
message_stop, and rejects thinking-only/empty/error streams. It makes a real
model request when a real provider is selected and can consume quota.

Local validation: `npm run test:proxy` compiles TypeScript and runs a loopback
mock plus mocked VS Code API and webview message tests. No keys/internet are
used. These tests establish local protocol/lifecycle behavior; an unavailable
relay cannot be declared working on that basis. Browser appearance and actual
Claude client behavior need extension-host acceptance separately.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the license of the
adapted relay compatibility modules.
