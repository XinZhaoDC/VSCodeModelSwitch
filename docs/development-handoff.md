# AgentDeck 开发交接入口

此文档用于换 Codex 官方账号、换会话或换环境后恢复开发。代码和文档不会随账号切换而丢失，但新会话不会自动拥有上一账号的对话上下文。

## 当前基线与入口

- 插件显示名：AgentDeck；仓库/本地源码目标名：AgentDeck。内部身份仍为 `xinzhaodc.vscodemodelswitch`，配置键、命令 ID 和数据键有意保留，不能批量更名。
- 当前运行版本：0.10.0；本轮发布 tag 为 `v0.10.0`，创建/推送结果以 Git 和任务 RESULT 为准。发布检查只新增测试、文档和仓库元数据，不改该版运行逻辑。
- 容器源码：`/home/workspace/Forest_Interface/code/AgentDeck`。环境入口仍是 `enter-vscodemodelswitch`，Node22 前缀不更名。
- 唯一总任务：`HO-20261109-001` / `vscodemodelswitch-fusion`，owner 为 Forest_Interface。
- 总任务正文：`/home/workspace/Forest_Interface/AI_prompt/tasks/task_HO-20261109-001_vscodemodelswitch-fusion.md`，只默认读取到 `ACTIVE_TASK_READ_END`。
- 权威结果：`/home/workspace/Forest_Interface/.ai/results/HO-20261109-001-result.md`。最新证据：`environment/logs/HO-20261109-001/codex-release-audit-20261112-001/`。
- 最新实际提交、tag、远程更名是否完成，以 Git 状态和上述结果为准，不按本文件中的目标路径猜测。

先完整读取适用 AGENTS.md、owner 数据库导航和活动任务，再读 [客户端架构](client-architecture.md)、[存储管理](management.md)、[独立网络](network-proxy.md)、[开发日志](development-log.md)、[验证记录](validation.md)。不要重新执行历史控制区的旧 next。

## 已实现与责任划分

`src/clients/index.ts` 注册客户端，`src/shell/clientRegistry.ts` 提供导航/消息/页面契约。Codex 和 Claude 各有 controller/view/adapter；Codex 历史与诊断已归位到其客户端目录。`src/shared/` 放真正公用的供应商、请求字段和确认组件，`src/ui/sidebarView.ts` 是壳和共享表单，`src/app.ts` 仍负责生命周期与共享服务，不是完全拆散的独立插件。未来客户端可以注册自有页面和消息；WorkBuddy 仅有测试夹具，没有真实适配器。

Codex 页面：总览 → 数据与存储 → 网络设置 → 账号与 API。统一折叠模块、中文说明、模块局部结果、十秒反馈、必须重载/短暂建议两类状态已实现。API 有空群组、两级排序、移动、环境独立禁用、当前供应商保护、可复用请求模板与 v2 导入导出。默认“独立供应商”可排序，名称在各客户端范围内唯一。

共享：供应商定义、Key 引用、群组/模板及对应档案历史。环境独立：当前供应商、启用/禁用、网络、活动档案绑定、配置与认证缓存。Provider 日常存储仍是 VS Code globalState/SecretStorage；数据目录的 providers 是主动导出位置，不是自动同步源。

官方档案各自共享历史；所有 API 供应商使用一个 API 档案。`CODEX_HOME` 是客户端入口，sessions/archived_sessions 链接到共享历史，sqlite_home 指向对应共享索引。固定挂载根不能重命名时只更换历史子目录链接；认证/配置在入口与本环境私有缓存之间明确切换。不要删除用户的 ai_client_data/codex。

## 后续 Claude 页面优化

这是用户计划中的下一阶段，不属于本次 Codex 发布测试的已完成范围。用户明确开始后再实施：以 Codex 的信息层级、折叠样式、中文说明、局部反馈、日志和设置交互为参照，保留 Claude 自身配置与认证协议。先盘点现有 Claude 行为，再给出差异清单，避免直接复制 Codex 的账号历史实现、API字段或 Linux专属启动入口。

必须保持 Codex/Claude 的消息归属、同名数据空间和网络独立，不修改扩展宿主 process.env 或共享 http.proxy 来完成新路由。Claude 当前通过自身 settings.json 的 env 及扩展环境变量影响正常 CLI/插件；Codex 通过 Linux 子进程 dispatcher。浏览器登录和 VPN 节点切换不在插件控制范围内。Windows/WSL独立入口及跨OS历史仍未验收。现有共享表单草稿、配置导入和公用反馈的修改需要定向回归 Codex，不能只测试新 Claude 页面。

本轮 Codex 自动化覆盖不能作为 Claude 的测试证据。真实图形界面拖动、官方账号和付费模型、宿主 Chats、Windows/WSL 是仍需实机验收的边界。详细结果请读最新 RESULT，不沿用旧测试数字。

## 换成另一个官方账号前

先结束当前任务并完成交接。由用户在 AgentDeck 创建/选择**另一个官方账号档案**，确认切换、重载后在官方 Codex 登录新账号；不要让新账号继续使用旧账号档案的认证或历史。旧账号档案和环境缓存保留。新账号通常需要自行登录，这与复用同一个账号在同一环境中的缓存不同。

开发上下文通过这份交接文档和同一任务文件恢复，与登录缓存或旧会话是否在 Chats 中可见无关。

## 可直接发给新账号 AI 的提示词

```text
继续 AgentDeck 开发，总任务 HO-20261109-001（vscodemodelswitch-fusion），owner Forest_Interface。
请先读取 /home/workspace/AGENTS.md、Forest_Interface 的适用规则与数据库导航，
再读唯一任务的当前控制区（读到 ACTIVE_TASK_READ_END），
以及 /home/workspace/Forest_Interface/code/AgentDeck/docs/development-handoff.md。
按交接导航阅读架构、存储、网络、开发日志和最新验证结果，并核对 Git/安装版本。
不要扫描其他算法根，不恢复旧历史 next，不删除现有历史数据，不读取或输出认证/Key正文。
本会话来自新的 Codex 官方账号；沿用同一个任务和文档，不另建账号专属任务副本。
我的下一阶段目标：将 Claude Code 页面的布局和适用功能优化到与 Codex 页面一致，
同时保持各客户端领域/状态/网络/历史相互独立，并保留扩展第三客户端的能力。
请先总结已完成、未验收、Claude特有差异和最小实施方案；此条只要求恢复上下文和设计，
暂不实施，不改登录、共享目录、VPN或运行配置。等我确认方案后再修改。
```
