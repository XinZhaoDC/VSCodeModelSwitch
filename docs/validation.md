# VSCodeModelSwitch Validation Guide

This project can be validated locally without publishing to the VSCode Marketplace.

## Codex proxy and mode status — v0.4.0 — 2026-10-22

Run the automated checks with existing dependencies:

```bash
npm run check
npm run test:proxy
npm run test:codex-proxy
npm run test:codex-modes
```

Completed validation: TypeScript check/compile passed, **64 UI/lifecycle/CC
checks** and **22 Codex proxy checks** passed, and sandbox official/API/auth
assertions passed. The tests cover native Responses and Anthropic translation,
tools/images/opaque state, response identity/continuation, JSON/SSE completion,
retry/timeout/cancellation, local web tools, pending Apply, rollback, independent
reload snapshots and mode buttons. Requests and credentials are synthetic;
servers bind to loopback. Mode tests retain a unique temporary sandbox rather
than deleting an old fixed directory.

`vscodemodelswitch-0.4.0.vsix` was built and installed locally. Its 60 compiled
files matched the tested build and installation byte for byte. No Marketplace
release, live provider call or real client configuration change was performed.

After `Developer: Reload Window`, check the real webview:

1. The overview has Tool / Mode / Provider Name / Model ID / Status columns.
2. Official Codex needs no saved API source: show Official account, Signed in
   or Login required, and Client default when no model is configured. Signed in
   only detects locally stored login credentials, not remote session validity.
3. Current mode is explicit; Use Official Account and Apply API Provider are
   buttons. Already-active official mode disables its action to keep the login.
4. Use sandbox before testing a mode switch: it clears both config/auth files.
   API Apply can select a saved source even when official mode had no active one.
5. Both Config editors expose proxy controls; Codex selects Responses or
   Anthropic upstream format. Saving should leave the applied route unchanged.

Visual rendering and real CLI/upstream acceptance remain manual checks. See
[native proxy protocol limits](native-proxy.md) before changing API format.

## Historical: Codex mode controls and Verify Model fix — v0.3.3 — 2026-10-21

The Codex section now exposes tool-level `Apply Official` and `Apply API` radio
actions. Both clear `config.toml` and `auth.json`; Official mode leaves Codex
ready for a fresh login, while API mode writes the selected API provider after
the clean reset. Codex API provider editing follows the Claude Code flow.

Validation completed:

- TypeScript check and compile passed.
- `scripts/test-codex-modes.js`: **8 passed, 0 failed**.
- `scripts/test-proxy.js`: **44 passed, 0 failed**.
- `vscodemodelswitch-0.3.3.vsix` was packaged and inspected for the new radio
  controls and compiled Codex adapter.
- Tests use sandbox paths and synthetic credentials; real Codex files and
  SecretStorage were not modified.

After installing the VSIX, run `Developer: Reload Window` and accept the first
official-mode login interactively in Codex. The real client login and provider
endpoints remain installation-time checks.

## Native proxy v0.2.0 validation — 2026-10-13

## Native proxy v0.2.1 host-proxy transport — 2026-10-17

`src/proxy/transport.ts` now uses the extension host's global `fetch` for
ordinary relay requests, retries and web tools. TypeScript check/compile passed;
the local suite completed **44 passed, 0 failed**, including an explicit test
that the shared transport calls `fetch`, preserves manual redirects, response
headers and response bytes. VSIX `vscodemodelswitch-0.2.1-host-proxy.vsix` was
packaged with the compiled proxy modules. No live provider request or client
configuration was changed. Install the new VSIX in the remote VS Code window
before doing AgentRouter end-to-end verification.

TypeScript check and compilation passed using the existing Node22 prefix.
`scripts/test-proxy.js` completed **43 passed, 0 failed** against loopback HTTP,
mocked VS Code APIs and the generated webview's JavaScript/DOM message flow.

The checks cover reconstructed/native SSE, terminal events/errors, JSON/tool
repair, paired history trimming, provider isolation, retries/cancellation,
WebFetch/image inputs, mixed web/client-tool deferral, Save/Apply/Verify
separation, metadata/config-write rollback, reload, terminal-only mode and
existing-provider UI editing/reset/cancel. They do not access provider keys or
the internet and do not write real CLI configuration files.

The VSIX `vscodemodelswitch-0.2.0-native-proxy.vsix` was built and its archive
checked for all six proxy modules, matching compiled files, workspace-host
metadata, usage documentation and the adapted modules' license/notice. Python
dependencies, auth files and test environments are absent from the archive.

No extension was installed or published. Visual rendering in a real VS Code
webview and actual Claude/justdowork end-to-end behavior remain to be accepted
after installation. These local results do not supersede the separate relay
availability test. Evidence: Interface `.ai/results/HO-20261013-002-result.md`.

## 1. Compile

```bash
npm ci
npm run check
npm run compile
```

Expected result:

- TypeScript compilation completes without errors.
- `out/` contains the compiled extension.

## 2. Start Mock Model Server

```bash
npm run mock:models
```

Use this endpoint in the extension:

```text
http://localhost:8787
```

Use any non-empty API key:

```text
test-key
```

The mock server supports:

```text
GET /v1/models
GET /models
GET /user/balance
POST /v1/messages
POST /v1/responses
```

## 3. Run Extension Development Host

In VSCode:

1. Open this folder.
2. Press `F5`.
3. A new Extension Development Host window opens.
4. Click the VSCodeModelSwitch icon in the Activity Bar.
5. Use the side bar Providers UI.

Add a provider:

```text
Tool: Claude Code
Name: Local Mock
Base URL: http://localhost:8787
Key: test-key
Click Fetch Models
Model ID: choose/type claude-sonnet-4-20250514, or leave it empty
Set active after saving: unchecked
Save Provider
Click Apply on the saved provider
```

Add another provider:

```text
Tool: Codex
Name: Local Mock Codex
Base URL: http://localhost:8787
Key: test-key
Click Fetch Models
Model ID: choose/type gpt-5-codex, or leave it empty
Set active after saving: unchecked
Save Provider
Click Apply on the saved provider
```

Expected result:

- Model fetch succeeds.
- The Claude Code provider list shows `Local Mock` as active.
- The Codex provider list shows `Local Mock Codex` as active.
- Each provider is displayed as one compact row with name, model, and row-level actions.
- Non-active providers show `Apply`; active providers show `Active`.
- The row-level `Model` button fetches models for that provider and lets you choose a new model.
- `Config` edits the stored complete configuration and key for one provider.
- `Applied Config` opens the effective configuration file for a tool.
- A provider without a model shows `NULL`; Apply remains available while
  `Verify Model` remains disabled.
- The VSCode status bar shows separate Claude and Codex entries with provider/model.
- If the active config file is edited externally, the status bar should update after the file watcher fires.

To validate synced-provider behavior:

1. Export a public config.
2. Import it in a fresh Extension Development Host profile or after clearing secrets.
3. Provider rows should show `Key missing on this machine`.
4. Click that provider's `Config` button.
5. Enter `test-key` in the API Key field and save.
6. `Apply` and `Model` should become available again.

- Global config sync is enabled by default and writes to real config files by default.
- Set `vscodemodelswitch.configTarget` to `sandbox` before testing if you do not want to touch real `~/.claude` and `~/.codex`.

The Command Palette commands still work, but the side bar UI is the primary flow.

## 4. Validate Terminal Env

Click `Terminal` in the corresponding provider group to apply and open its CLI.
For environment validation, interrupt the launched CLI and check without printing
the secret value:

```bash
echo $ANTHROPIC_BASE_URL
echo $OPENAI_BASE_URL
test -n "$ANTHROPIC_AUTH_TOKEN" && echo ANTHROPIC_AUTH_TOKEN=set
test -n "$OPENAI_API_KEY" && echo OPENAI_API_KEY=set
```

Expected:

```text
http://localhost:8787
http://localhost:8787
ANTHROPIC_AUTH_TOKEN=set
OPENAI_API_KEY=set
```

Click `Claude Terminal` in the side bar, or run:

```text
VSCodeModelSwitch: Open Claude Terminal
```

In the created terminal:

```bash
echo $ANTHROPIC_BASE_URL
test -n "$ANTHROPIC_AUTH_TOKEN" && echo ANTHROPIC_AUTH_TOKEN=set
```

Expected:

```text
http://localhost:8787
ANTHROPIC_AUTH_TOKEN=set
```

Click `Codex Terminal` in the side bar, or run:

```text
VSCodeModelSwitch: Open Codex Terminal
```

In the created terminal:

```bash
echo $OPENAI_BASE_URL
test -n "$OPENAI_API_KEY" && echo OPENAI_API_KEY=set
```

Expected:

```text
http://localhost:8787
OPENAI_API_KEY=set
```

The command also sends `claude` or `codex` automatically. For pure env testing, interrupt that command and run the `echo` checks.

## 5. Validate Safe Global CLI Sync

By default, config files are written under:

```text
~/.claude/settings.json
~/.codex/config.toml
```

To use sandbox mode, set workspace settings in the Extension Development Host:

```json
{
  "vscodemodelswitch.globalCliSync": true,
  "vscodemodelswitch.configTarget": "sandbox",
  "vscodemodelswitch.testHome": ""
}
```

Click `Apply` on each provider card.

Expected files:

```text
<workspace>/.vscodemodelswitch-home/.claude/settings.json
<workspace>/.vscodemodelswitch-home/.codex/config.toml
```

No real files under your actual home directory should be touched in sandbox mode.

Use `Applied Config` in each provider group to open the generated file directly.
Apply a provider a second time and verify that a backup exists under:

```text
<workspace>/.vscodemodelswitch-home/.claude/vscodemodelswitchbak/
<workspace>/.vscodemodelswitch-home/.codex/vscodemodelswitchbak/
```

Use this default setting when you are ready to write real machine config:

```json
{
  "vscodemodelswitch.configTarget": "real"
}
```

## 6. Validate Public Import/Export

Click `Export` and `Import` in the VSCodeModelSwitch side bar, or run:

```text
VSCodeModelSwitch: Export Public Config
VSCodeModelSwitch: Import Public Config
```

Expected:

- Exported JSON contains provider metadata.
- Exported JSON does not contain API keys.
- After importing on another machine, status should indicate missing key until local keys are entered.

Search the exported file for the mock key. The command must produce no output:

```bash
rg -n 'test-key' /path/to/exported-config.json
```

## 7. Validate Full Configuration

1. Select `Full configuration` in Add Provider.
2. Fill the Base URL and API key at the recognized template locations.
3. Leave `model` and Claude `effortLevel` empty, then save.
4. Confirm the provider appears with Model ID `NULL` and is not automatically active.
5. Open `Config`, add a model, click `Save`, and verify that the card updates.
6. Add a duplicate JSON/TOML field and verify that Save reports a validation error.

## 8. Validate Network, Usage And Cleanup

For each mock provider:

1. Click `Network & Usage`; network and Models API should pass.
2. Open `Config`, enable Usage Query, select `Auto Detect`, save, and run
   `Network & Usage` again. The mock remaining quota is `12.5 USD`.
3. Use the automated proxy suites above for `Verify Model` completion/error
   checks. The standalone `mock:models` server only supplies a minimal JSON
   fixture and does not simulate a complete verified SSE/Responses answer;
   its HTTP200 must not be treated as model success.
4. Open `View -> Output`, select `VSCodeModelSwitch`, and confirm diagnostics
   contain no API key or raw response body.
5. Confirm the global status area shows log and backup sizes.
6. Test `Delete Log` and each tool's `Delete Backups` confirmation.
7. Delete a provider and verify that its applied config file and backups remain.

## 9. Package VSIX

```bash
npm run package
```

Expected:

- A `.vsix` file is generated.
- It can be installed from VSCode with `Extensions: Install from VSIX...`.
