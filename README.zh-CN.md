# VSCodeModelSwitch

[English](README.md) | 简体中文

VSCodeModelSwitch 是一个管理和切换 Claude Code、Codex API Provider 的
VS Code 插件。Provider 元数据集中显示在侧边栏；API key 在 Provider 被
Apply 之前保存在 VS Code SecretStorage 中。

代码仓库：[XinZhaoDC/VSCodeModelSwitch](https://github.com/XinZhaoDC/VSCodeModelSwitch)

这是从原 VSModelSwitch 项目派生并独立维护的私有版本。原项目的 MIT
许可证和署名保留在 [`LICENSE`](LICENSE) 中。

<p align="center">
  <img src="media/poster.png" alt="VSCodeModelSwitch 海报" width="720">
</p>

## 功能概览

- 分开管理 Claude Code 与 Codex Provider、Active 状态和工具操作锁。
- 支持“关键字段”和“完整 JSON/TOML 配置”两种添加方式。
- Provider 支持编辑、排序、删除、切换模型和独立 Apply。
- `/models` 可用时加载模型建议，不可用时仍可手动输入或留空 Model ID。
- Apply 前备份并完整替换目标 CLI 配置。
- 按规范化 Base URL + API key 匹配已应用 Provider，末尾 `/v1` 不影响匹配。
- 提供按需网络检查、真实模型协议验证和可选额度查询。
- 导入和导出会清除 API key；SecretStorage 不参与导出。
- 显示日志、Claude 备份、Codex 备份大小并提供范围明确的删除按钮。

## 要求与 VSIX 安装

- VS Code 1.96 或更新版本。
- 从源码构建建议使用 Node.js 22。
- `claude`、`codex` CLI 需要根据实际用途另外安装。

通过 VS Code 图形界面安装本地构建包：

```text
扩展 -> ... -> 从 VSIX 安装...
```

选择 `vscodemodelswitch-<version>.vsix`，安装后运行：

```text
Developer: Reload Window
```

## 首次使用先开启 Sandbox

Apply 会完整替换目标配置，因此第一次测试不要直接使用 real。通过命令面板
运行 `Preferences: Open Workspace Settings (JSON)`，写入：

```json
{
  "vscodemodelswitch.globalCliSync": true,
  "vscodemodelswitch.configTarget": "sandbox",
  "vscodemodelswitch.testHome": ""
}
```

默认 sandbox 目录：

```text
<workspace>/.vscodemodelswitch-home/
```

real 模式使用当前扩展宿主所看到的用户 home：

```text
~/.claude/settings.json
~/.codex/config.toml
```

每次完整替换前，原文件分别备份到：

```text
~/.claude/vscodemodelswitchbak/
~/.codex/vscodemodelswitchbak/
```

Sandbox 使用相同的相对目录结构。

## 使用说明

### 1. 启用工具

打开活动栏中的 VSCodeModelSwitch。Claude、Codex 各自拥有 `Enabled`
操作锁和折叠按钮。关闭 Enabled 后不能修改对应工具，但仍可打开
`Applied Config` 检查当前文件。折叠按钮会隐藏整个 Tool 面板。

### 2. 添加 Provider

`Key fields` 模式只要求：

- Tool
- Name
- Base URL
- API Key

`Fetch Models` 会在 Provider 支持模型列表接口时加载建议。失败只显示警告，
可以直接输入 Model ID，也可以留空。空模型统一显示为 `NULL`，以后可通过
`Config` 或 `Model` 调整。`Set active after saving` 默认不勾选。

`Full configuration` 会提供完整 Claude JSON 或 Codex TOML 模板。必须在
规定位置填写 Base URL 和 API key，其他内容可以调整或删除。Model 和 Claude
的 `effortLevel` 可以为空或省略；重复 JSON/TOML 字段会被拒绝。

插件只识别以下 key 位置：

```text
Claude: env.ANTHROPIC_AUTH_TOKEN
Codex:  model_providers.OpenAI.experimental_bearer_token
```

保存 Provider 时，key 会从配置文本中清除并转存 SecretStorage。Apply 时必须
把 key 写回所选 Claude/Codex CLI 配置，否则 CLI 无法认证。

### 3. Apply、编辑与删除

- `Apply`：只备份并完整替换该工具的目标配置。
- `Config`：Apply 前编辑 Provider 的完整配置、API key 和 Usage 设置。
- `Model`：重新获取建议并修改保存的模型。
- `Delete`：确认后删除 Provider 元数据及其 SecretStorage key；不会删除已
  应用的配置和历史备份。
- `Applied Config`：打开当前用于匹配状态的实际配置文件。

全局状态包括 `Off`、`Unactivated`、`Ready`、`Key missing`、
`Models stale`、`Degraded` 和 `Network error`。工具关闭或未激活时 Provider、
Model 均显示 `NULL`；已应用配置没有模型时 Model 也显示 `NULL`。

### 4. 网络、模型验证与 Usage

- `Network & Usage` 检查基础网络、Models API 和已启用的 Usage。工具级检查
  最多并发两个 Provider，并支持取消。
- `Verify Model` 对 Claude 发送最小 `/v1/messages` 请求，对 Codex 发送最小
  `/v1/responses` 请求，可能产生极少量 API 用量。
- Usage 默认关闭。`Auto Detect` 最多用 20 秒尝试同源常见额度端点。很多
  中转站不允许用模型 API key 查询账户余额；New API 类型还需要独立的
  Management Access Token 和 User ID。Usage 失败不代表模型不可用。

插件使用远程/容器 Extension Host 的网络路由。VPN TUN 是否生效取决于容器
DNS 和路由，不能只根据宿主机浏览器能否打开 Provider 网站判断。

### 5. 日志、备份与导入导出

通过 `视图 -> 输出` 打开输出面板，在右侧下拉列表选择
`VSCodeModelSwitch`。日志只记录端点、状态和 JSON 字段结构，不记录 API key
或原始响应正文。全局区域显示当前扩展日志目录和备份目录大小。

`Delete Log` 只删除本扩展当前日志目录的普通日志文件。Claude、Codex 各有
独立的 `Delete Backups`。这些删除操作都要求确认。

`Export` 保存完整 Provider 模板和元数据，但会清空 API key 与管理 Token。
`Import` 会拒绝同工具重名 Provider。导入后需要通过 `Config` 在本机重新填写
key。

## 从源码构建

使用锁文件安装依赖并依次检查、编译、打包：

```bash
npm ci
npm run check
npm run compile
npm run package
```

以下内容均为可重新生成的忽略项，不应提交 Git：

```text
node_modules/
out/
*.vsix
.vscodemodelswitch-home/
```

当前容器的独立 Node 环境和 VSIX 更新流程见
[`AI_Prompt/01-独立环境安装与VSIX构建.md`](AI_Prompt/01-独立环境安装与VSIX构建.md)。

## Sandbox 回归测试

1. 按上文把 Workspace Settings 设置为 sandbox。
2. 在独立终端运行 `npm run mock:models`，保持服务运行。
3. 添加 Claude：Base URL 为 `http://localhost:8787`，key 为 `test-key`。
4. 获取或输入 `claude-sonnet-4-20250514`，保持自动激活未勾选，保存后手动
   点击 `Apply`。
5. 添加 Codex，使用 `gpt-5-codex`，然后手动 Apply。
6. 检查 `.vscodemodelswitch-home/` 下两个配置文件是否与所选 Provider 一致。
7. 分别执行 `Network & Usage` 和 `Verify Model`。
8. 再次 Apply，确认全局显示的备份大小增加。
9. Export 后确认导出文件不包含 `test-key`。
10. 删除 Provider，确认已应用配置文件没有被删除或修改。

完整回归清单见 [`docs/validation.md`](docs/validation.md)。

## 安全说明

- 即使正常 Export 会清除已识别密钥，提交导出文件前仍应人工检查。
- Apply 会有意把 key 写入 CLI 配置文件，因此需要保护 effective home 和备份
  目录的访问权限。
- Usage Auto 只从当前 Provider origin 派生候选路径，不会把凭据发送到无关
  域名。
- 插件不实现 HTTP 代理，也不拦截 Claude/Codex 请求；Provider 没有 Usage API
  时，插件无法得出权威余额。

## License

MIT
