# VSCodeModelSwitch Product Logic

## 产品定位

VSCodeModelSwitch 是一个面向 VSCode 的 Claude Code 和 Codex provider 管理插件。它的核心目标是：

- 用户在 VSCode 内分别维护 Claude Code provider 和 Codex provider。
- 切换 provider 后，VSCode 内新启动的 Claude Code 和 Codex 自动使用对应的 URL、key 和模型策略。
- 模型名称可以从接口获取、手动填写或暂时留空。
- provider 元数据可以通过 VSCode 账号同步；API key 保持本机存储。
- 支持导入、导出，避免多台机器混用配置。

第一版只支持 Claude Code 和 Codex，不做本地代理，不做其他 AI CLI。

## 核心原则

1. 一个 provider 只属于一个工具：Claude Code 或 Codex。
2. URL 和 key 是用户必须确认的最小输入。
3. URL 和 key 是必要输入；Model ID 是可选输入。
4. 默认写入 CLI 配置文件，同时更新 VSCode terminal 环境变量。
5. key 不进入 VSCode settings、workspace settings 或普通导出文件。
6. Apply 写入前备份，并用保存的完整模板替换目标配置文件。

## Provider 数据模型

一个 provider 只属于一个工具，Claude Code provider 和 Codex provider 分开管理。

```ts
type ProviderProfile = {
  id: string;
  name: string;
  tool: 'claude' | 'codex';
  baseUrl: string;
  modelPolicy: ModelPolicy;
  secretRef: string;
  codex?: {
    providerId: string;
    wireApi: 'responses' | 'chat';
  };
};

type ModelPolicy =
  | { type: 'fixed'; model: string }
  | { type: 'custom'; model: string };
```

第一版保存时使用 `fixed`，来源是模型列表选择；`custom` 只作为后续高级入口。

## 模型获取逻辑

### 目标体验

用户添加 provider 时：

```text
选择工具类型 Claude Code / Codex
  -> 填 provider 名称
  -> 填 base URL 和 key
  -> 可选 Fetch Models
  -> 选择、手动填写或留空模型
  -> Save Provider
  -> Set active
```

模型区域使用带建议列表的可编辑输入框：

```text
[Fetch Models]
Model ID: <editable input with suggestions>
```

### OpenAI-compatible / Codex 模型获取

请求策略：

```text
1. 如果 baseUrl 以 /v1 结尾，请求 {baseUrl}/models
2. 否则先请求 {baseUrl}/v1/models
3. 失败后再尝试 {baseUrl}/models
```

认证：

```text
Authorization: Bearer <key>
```

解析：

```ts
type OpenAIModelsResponse = {
  data: Array<{ id: string; object?: string }>;
};
```

排序规则：

1. provider 显式标记的 recommended model。
2. 名称包含 `codex` 的模型。
3. 最新 GPT 主线模型。
4. 名称包含 `reason`、`thinking`、`r1` 等推理特征的模型。
5. 其他聊天模型。

如果模型列表为空或接口不可用：

- UI 显示 warning，但允许手动填写或留空模型后保存 provider。

### Anthropic-compatible / Claude Code 模型获取

请求策略：

```text
1. 如果 baseUrl 以 /v1 结尾，请求 {baseUrl}/models
2. 否则先请求 {baseUrl}/v1/models
3. 失败后再尝试 {baseUrl}/models
```

认证：

```text
Authorization: Bearer <key>
anthropic-version: <configured-version>
```

认证失败时兼容回退到 `x-api-key`。

解析：

```ts
type AnthropicModelsResponse = {
  data: Array<{ id: string; display_name?: string }>;
};
```

排序规则：

1. provider 显式标记的 recommended model。
2. Claude Code 默认模型策略。
3. 名称包含 `sonnet` 的最新模型。
4. 名称包含 `opus` 的最新模型。
5. 名称包含 `haiku` 的最新模型。
6. 其他模型。

如果模型列表不可用：

- UI 显示 warning，但允许手动填写或留空模型后保存 provider。
- 如果已保存 provider 的模型列表刷新失败，继续使用原模型并记录诊断。

## 模型缓存

模型列表按 endpoint 和 key 指纹缓存：

```ts
type ModelCacheEntry = {
  tool: 'claude' | 'codex';
  baseUrl: string;
  keyFingerprint: string;
  fetchedAt: string;
  ttlMs: number;
  models: ModelInfo[];
  error?: string;
};
```

缓存规则：

- 默认 TTL: 24 小时。
- 用户点击 refresh 时强制刷新。
- baseUrl 或 key 变化后缓存失效。
- 只保存 key 的 hash 指纹，不保存明文 key。

## 添加 Provider 流程

```text
Add Provider
  -> 选择工具类型：Claude Code 或 Codex
  -> 输入 provider 名称
  -> 输入 URL/key
  -> 可选点击 Fetch Models
  -> 选择、手动填写或留空模型
  -> 保存 provider
  -> 立即应用或稍后应用
```

Claude Code 和 Codex 分开添加，分别展示在各自 provider 分组里。

## 切换 Provider 流程

```text
Use Provider
  -> 点击某个非当前 provider 卡片上的 Use
  -> 设置该工具当前 provider
  -> 从 SecretStorage 读取 key
  -> 更新 VSCode terminal environmentVariableCollection
  -> 默认写入真实 CLI 配置文件
  -> 更新状态栏
  -> 提示重启已有 Claude/Codex terminal
```

当前 provider 卡片只显示 `Active`，不再显示不可点击的 `Selected` 按钮。`Use` 本身就是选择并应用。

## 启动扫描

插件启动时读取：

```text
<effective-home>/.claude/settings.json
<effective-home>/.codex/config.toml
```

并用规范化 `baseUrl + API key` 匹配已保存 provider。末尾 `/v1` 不影响匹配；模型变化不改变 Provider 身份。

默认 `<effective-home>` 是真实用户 home。设置 `vscodemodelswitch.configTarget = sandbox` 后才使用 workspace 下的 `.vscodemodelswitch-home`。

已经运行的 Claude Code 和 Codex 进程不能无感热切。插件只保证：

- 新 terminal 生效。
- 新启动的 `claude` / `codex` 生效。
- 插件创建的 AI terminal 可以一键重启。

## Apply Scope

插件提供两个应用范围。

### VSCode Terminal Scope

可选模式。

行为：

- 通过 `environmentVariableCollection` 注入环境变量。
- 新建 VSCode terminal 自动继承。
- 不主动改全局 CLI 配置。

适合：

- 多台电脑配置不同。
- 不想影响系统终端。
- 只希望 VSCode 内使用当前 provider。

### Global CLI Sync Scope

默认模式。

行为：

- Claude Code adapter 写入 `<effective-home>/.claude/settings.json`。
- Codex adapter 写入 `<effective-home>/.codex/config.toml`。
- 默认 `<effective-home>` 是真实用户 home。
- 设置 `vscodemodelswitch.configTarget = sandbox` 后写入测试 home。
- 写入前备份。
- 用 Provider 保存的完整配置替换目标文件。

适合：

- 希望 VSCode 外部终端也使用同一 provider。
- 当前 CLI 对环境变量支持不足，需要落盘配置。

## Claude Code Adapter

Terminal env:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
```

可选配置文件：

```text
~/.claude/settings.json
```

插件管理字段：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "...",
    "ANTHROPIC_AUTH_TOKEN": "..."
  },
  "model": "..."
}
```

Provider 可以不保存模型；此时界面显示 `NULL`，Apply 保留模板中的空值或省略状态。

## Codex Adapter

Terminal env:

```text
OPENAI_BASE_URL
OPENAI_API_KEY
```

可选配置文件：

```text
~/.codex/config.toml
```

插件管理字段：

```toml
model_provider = "OpenAI"
model = "..."

[model_providers.OpenAI]
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = false
base_url = "..."
experimental_bearer_token = "..."
```

Codex Provider ID 固定为 `OpenAI`；Provider 显示名称只保存在插件元数据中。模型可以为空。

## 同步与导入导出

### VSCode 账号同步

可同步：

- provider 名称
- baseUrl
- modelPolicy
- currentProviderIds
- apply scope preference

不可同步：

- API key
- token
- headers 中的敏感值

新机器同步后，如果缺 key，状态显示：

```text
ProviderName
Model
Key missing on this machine
```

通过 Provider 的 `Config` 打开配置编辑器，在 password input 中补充本机 key。

### Public Export

导出不含 key 的 JSON：

```json
{
  "version": 1,
  "providers": [],
  "currentProviderIds": {
    "claude": "...",
    "codex": "..."
  }
}
```

适合团队共享和普通备份。

### Encrypted Export（未实现）

导出包含 key 的加密备份：

```json
{
  "version": 1,
  "encrypted": true,
  "cipher": "aes-256-gcm",
  "kdf": "argon2id",
  "payload": "..."
}
```

当前代码不提供此功能；本节仅保留为候选方向。

## 配置文件查看

侧边栏提供：

```text
View Claude Config
View Codex Config
```

用于直接打开：

```text
~/.claude/settings.json
~/.codex/config.toml
```

在测试模式下路径受 `vscodemodelswitch.testHome` 控制。

## 状态栏状态

```text
AI: ProviderName
AI: ProviderName (key missing)
AI: ProviderName (models stale)
AI: ProviderName (degraded)
AI: Off
```

点击状态栏打开：

```text
Switch Provider
Open Claude Terminal
Open Codex Terminal
Refresh Models
Test Provider
Edit Provider
Export Config
```

## Provider 列表 UI

Claude Code 和 Codex 各自是一个 provider 列表。每个 provider 占一行：

```text
Name
Model                         Use / Active    Model
```

- `Apply`: 选择并立即应用该 provider。
- `Active`: 当前工具正在使用的 provider 状态。
- `Model`: 拉取该 provider 的模型列表，并从列表中选择新的模型。

工具级按钮放在分组标题或分组工具栏：

- `Config`: 位于具体 Provider 卡片中，编辑其保存配置和 key。
- `Applied Config`: 位于工具标题右侧，打开当前实际配置文件。
- `Terminal`: 打开对应工具 terminal。
- `Refresh`: 刷新当前 active provider 的模型缓存。

## 状态栏真实状态

VSCode 状态栏显示两个独立项：

```text
Claude: <provider or url> / <model>
Codex: <provider or url> / <model>
```

状态来源优先级：

1. 读取当前有效配置文件。
2. 用规范化 `baseUrl + API key` 匹配 VSCodeModelSwitch 保存过的 provider。
3. 匹配成功显示 provider name，匹配失败显示 URL host 和 model。

插件会监听配置文件变化，并在配置文件被外部插件或手工编辑更新后刷新状态栏。

限制：

- 如果外部 VSCode 插件只在运行时内存里切换模型，但没有写入配置文件或可读取 API，VSCodeModelSwitch 无法可靠知道该内存态。
- 一旦外部插件把模型/URL 落到配置文件，状态栏会跟着更新。

## MVP 验收标准

1. 可以分别添加 Claude Code provider 和 Codex provider。
2. 添加 provider 时可以自动获取模型列表。
3. 用户可以获取、手写或留空 Model ID。
4. 切换 provider 后，新建 VSCode terminal 能获得正确 env。
5. 默认写入 CLI 配置文件，并可一键查看配置文件。
6. 可以一键打开 Claude Code terminal 和 Codex terminal。
7. provider 元数据可以被 VSCode 账号同步。
8. Provider 保存阶段 key 位于 SecretStorage；Apply 时按 CLI 要求写入目标配置。
9. 可以导出不含 key 的 public config。
10. 模型获取失败时显示 warning，并保留手动输入与空模型保存入口。

## 后续版本

- Provider templates: Anthropic, OpenAI, OpenRouter, DeepSeek, SiliconFlow, Moonshot。
- 模型能力标签：coding、reasoning、vision、long-context。
- 更广泛的 Provider Usage 适配。
- 加密导出。
- 配置 diff 预览。
- cc-switch 配置导入。
- 本地代理和协议转换。
