# AgentDeck 验证记录

## 0.10.0 / 已安装 Codex 专项发布验收

2026-11-12：已安装扩展、原交付 VSIX 与源码构建的128个out文件逐字节相同。20个Codex专属/公共能力套件253项具名检查及模式认证断言全部通过；16个其他客户端/扩展性场景明确排除，不计通过，不运行Claude原生程序。首次新增测试因夹具把未设置值表示为显式undefined而失败，修正夹具后通过；补充诊断断言区分服务可达与HTTP401模型目录失败，运行代码未改。原生Codex验证官方/API双环境历史列表及读取、两个API源默认过滤互见，以及指定HTTPS CONNECT代理。

真实环境只读检查：sessions和archived_sessions均链接到现有共享根，分别57/155个rollout；不读取聊天正文。代理12000匿名访问公共主页HTTP200，但当前官方扩展目录无新版dispatcher，不能据此宣称已启用独立聊天路由。无真实账号切换/迁移/网络写入、无付费模型请求；宿主Windows/WSL/真实鼠标与Chats未验收。命令、范围、源指纹、失败和最终结果见同任务codex-release-audit-20261112-001。宿主操作步骤见[宿主机验收](host-acceptance.md)。

复现命令（参数必须显式给出，原生检查不允许跳过）：

```bash
python3 scripts/test-codex-release.py \
  --node /path/to/node22 \
  --out /path/to/installed-extension/out \
  --native-codex /path/to/official-extension/bin/linux-x86_64/codex \
  --evidence /path/to/new-evidence-directory
```

`--out`也可以使用当前构建目录。证据目录必须不存在；其中保留原夹具指纹、精确排除清单、环境范围替换与逐套件结果。正式判定为final-001的20套件253检查；installed-001/002是保留的前序验证。

## 0.10.0 / 客户端模块与 Codex 群组

新增 test:provider-groups、test:group-ui、test:group-import；覆盖跨客户端归属、第三客户端注册/页面、群组/成员排序和禁用、当前供应商保护、模板复制、v1/v2及失败恢复。test:native-history 增加不同API地址/合成密钥的两环境共享历史默认过滤/读取检查，无模型请求。完整命令、首次失败及最终源码/包身份见 Forest_Interface/environment/logs/HO-20261109-001/client-groups-20261112-001/RESULT.md。

## 0.9.6 / Codex 全功能审查

新增 `test:codex-workflows` 执行实际 webview 脚本及存储/日志消息桥，检查各入口、官方账号与 API 诊断目标、网络备注和未测试状态。`test:isolated-network` 增加启动命令注册丢失/被覆盖检查；`test-native-network` 的原生 Codex 请求改用 HTTPS CONNECT 夹具。复现失败、最终完整回归、当前环境只读检查与匿名公共页面代理测试见 Forest_Interface/environment/logs/HO-20261109-001/codex-ui-audit-20261112-001/RESULT.md。

实际数据目录接入已由用户完成，AI 只核对链接、绑定与安全日志元数据。未自动迁移真实网络、登录、切换账号或调用付费模型；真实窗口视觉、账号/额度/聊天及 Windows/WSL 仍需验收。

## 0.9.5 / 挂载点连接与固定目录缓存

`npm run test:fixed-home` 在合成目录中模拟根重命名 EBUSY，不操作真实挂载。覆盖原子认证更新、登出、账号/API隔离、跨环境和跨库、失败/中断/冲突恢复、独立挂载历史子目录报错及失败首次接入重试。`test:native-history` 从真实目录入口写合成 rollout，用原生 app-server 列出/读取，再移除原环境入口和私有缓存，验证另一环境仍可读取。只设置合成 HOME，无登录或模型请求。

本轮命令/构建身份/结果与包审计：Forest_Interface/environment/logs/HO-20261109-001/mounted-home-20261111-001/RESULT.md。真实 VS Code/账户/挂载迁移由用户验收；Windows/WSL未测试。

## 0.9.4 / 网络状态措辞与按钮位置

编译、现有UI回归与包审计；检查状态徽标紧接操作按钮、旧/新/异常配置显示区分。前轮原生Linux两项代理入口验证日志已回读，无真实聊天测试或自动迁移。精确结果见Forest_Interface/environment/logs/HO-20261109-001/route-status-ui-20261111-001/RESULT.md。

## 0.9.3 / 原生确认语言

编译及197项相关检查通过：运行确认4、UI27、独立网络10、环境26、管理9、代理90、测速31。检查英文VSCode环境下的中文确认/取消、局部错误翻译与诊断分类保持、多环境代理和管理回归；实际命令、最终源码哈希与范围见Forest_Interface/environment/logs/HO-20261109-001/popup-chinese-20261111-001/RESULT.md。使用隔离夹具，不修改真实账户或代理；不视为Windows/WSL原生验收。

## 0.9.2 / AgentDeck 名称

仅显示名称修订：编译、现有 test-codex-ui 27项回归与包身份/编译文件一致性审计。未重复0.9.1全部157检查或原生网络/历史测试。详细结果见 Forest_Interface/environment/logs/HO-20261109-001/agentdeck-rename-20261111-001/RESULT.md。

## 0.9.1 / 中文与显示名称修订

本轮编译与157项相关检查通过：test-proxy 90、test-codex-ui 27、test-speed 31、test-management 9。覆盖中文默认、网络操作顺序、配置路径移除、原始名称/模型ID、反馈计时及原有管理功能。证据为 Forest_Interface/environment/logs/HO-20261109-001/chinese-ui-20261111-001/final-002；未重新进行真实登录、原生VPN聊天、Windows或WSL测试。前轮267项完整回归保留为0.9.0证据，不冒充本轮全量复测。

## 0.9.0 / 前轮完整验证

本轮最终完整检查：267 具名检查 + 模式/认证断言；原生 Linux 路由与 thread/list/read 均使用隔离空目录及合成数据。测试日志、源码哈希和每次失败尝试在 Forest_Interface/environment/logs/HO-20261109-001/codex-redesign-20261111-001。最新结果见其中 RESULT.md。真实账号、图形界面、Windows/WSL 和扩展升级仍不是自动检查证明的范围。

新增脚本：`scripts/test-isolated-network.js`（代理字段、父环境不变、普通 CLI 配置及回滚）、`scripts/test-management.js`（导出/导入隔离、快照管理、编辑器浏览、重载状态、只读账号 RPC）、`scripts/test-native-network.js <codex可执行文件> <claude可执行文件>`（本地代理故意错误响应）。`scripts/test-codex-ui.js` 增加提示计时、待重载/临时提醒、局部更新与数据原样保留验证。原生历史测试需要显式设置 `VSCODEMODELSWITCH_NATIVE_CODEX`；未设置时 SKIP 不能算原生验证通过。

下文保留此前版本验证说明；旧版共享 VS Code HTTP 代理行为以 0.9.0 网络说明替代。


Use the existing Node22 environment, run check/compile, then test-proxy.js, test-codex-proxy.js, test-codex-modes.js, test-speed.js, test-network.js, test-sessions.js, test-environments.js, test-recovery.js test-runtime-guard.js, test-operation-log.js and test-codex-ui.js. Use task-local TMPDIR and VSCODEMODELSWITCH_TEST_HOME. These are synthetic editor/filesystem fixtures and loopback services; no real credentials or model requests.

Storage checks cover two environments sharing an account's old/new rollouts, distinct auth/config and selections, singleton API history, reconnect/new environment, explicit legacy migration, backup/restore and broken links. Recovery checks inject partial apply failure, process exit and external modification; confirmation checks exercise one modal, cancel and accept without process inspection; logs cover default storage, verified relocation, failed persistence, other-window writes, rotation and scoped deletion. The DOM harness executes the complete webview script and verifies local green/red/cancel feedback, no scrolling, per-environment fold state, retained Tool field, official/API read-only modes and separate Claude layout. It does not validate browser painting or VS Code rendering.

Optional `VSCODEMODELSWITCH_NATIVE_CODEX=/path/to/codex node scripts/test-native-history.js` uses isolated HOME and synthetic data. It invokes initialize/thread/list/thread/read only; the former environment is removed before opening the same history in the second. No turn/start or login. This confirms installed native backend compatibility on this Linux filesystem, not real VS Code rendering or cross-OS mounts. See [management](management.md) for manual acceptance and limits.

The older sections below retain API/proxy validation context. Their pre-0.8 permanent Codex backup/reset descriptions are superseded by the current management contract.

# VSCodeModelSwitch Validation Guide

## Speed tests — v0.5.0

Run `npm run test:speed` for loopback SSE, synthetic official Codex, read-only
queries, model/configuration freshness, cancellation and UI/controller checks.
Keep existing proxy/mode regressions. See [measurement definitions and real-test
boundaries](speed-benchmark.md). Real requests consume quota and must be reported
separately from mocks; packaging does not activate an already-installed extension.

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
4. Use sandbox before testing a mode switch. Official authentication must be preserved; an API Apply must not overwrite a signed-in official identity.
   API Apply can select a saved source even when official mode had no active one.
5. Both Config editors expose proxy controls; Codex selects Responses or
   Anthropic upstream format. Saving should leave the applied route unchanged.

Visual rendering and real CLI/upstream acceptance remain manual checks. See
[native proxy protocol limits](native-proxy.md) before changing API format.

## Historical: Codex mode controls and Verify Model fix — v0.3.3 — 2026-10-21

The Codex section now exposes tool-level `Apply Official` and `Apply API` radio
actions. Official mode preserves `auth.json`; API mode requires its own identity and leaves Codex
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
# v0.6.0 network proxy acceptance

Run `npm run test:network` for synthetic editor Apply/reapply/restore/failure
behavior, HTTP CONNECT with remote-name resolution, direct loopback bypass,
redirect credential/bypass behavior, SSE and cancellation, API compatibility
relay composition, and verified HTTPS fixture certificates. Run existing proxy,
Codex mode/protocol and speed suites for regressions. No real account/model
requests are needed for these tests.

Then install the new VSIX manually. Keep the working host TUN mode while
applying `http://127.0.0.1:12000`, restart clients and check a real conversation.
Only afterward test host system-proxy mode with TUN off. Test both clients and
the API compatibility relay if used; port/HTTPS/mock success cannot replace this
acceptance. Restore original settings via Disable / Restore before downgrade.
See [network proxy](network-proxy.md).

## v0.6.1 Apply snapshot regression

The editor fixture in `scripts/test-network.js` now gives each getConfiguration
handle a fixed get() snapshot, while inspect()/update() use the latest model,
matching the installed VS Code extension host. With this fixture, the v0.6.0
manager reproduces the user's false HTTP override error on first Apply. The fix
must pass first Apply, reapply, target changes, reload, restore and rollback;
real HTTP and Claude workspace overrides must still reject Apply without
leaving either client's settings or saved state changed. Use `npm run check`,
`npm run test:network` and `npm run test:proxy`. No live credentials/model calls
are involved; real UI Apply and system-proxy chat acceptance remain separate.

## v0.6.2 Network proxy state controls

`npm run test:proxy` now checks explicit Off/Enabled badges and state-specific
button styles/locks, immediate submit locking, duplicate click suppression,
URL/bypass equivalence, edited and reverted drafts, target selection, background
refresh, successful Apply/Restore, failure/retry and generic busy transitions.
The fixture runs the actual webview script with synthetic messages/settings;
it does not apply real client settings or claim visual browser acceptance.
TypeScript check/compile and 82 UI/relay checks pass. The existing Enabled
configuration is retained after installing/reloading this UI update.
