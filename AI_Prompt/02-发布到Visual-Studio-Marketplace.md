# 发布到 Visual Studio Marketplace

当前项目采用私有 GitHub 仓库加 VSIX 手动安装，本文件是未来可选的发布
方案，不代表现在要公开发布。

## 发布后能得到什么

发布到 Visual Studio Marketplace 后，用户可以在 VS Code Extensions 视图
中直接搜索并安装扩展。新版本发布后，VS Code 在启用扩展自动更新时会
检查并安装新版本。

GitHub push 本身不会触发普通 VS Code 扩展更新，必须先构建并发布一个更高
版本的 VSIX。

## 发布前确认

检查 `package.json`：

```json
{
  "name": "vscodemodelswitch",
  "displayName": "VSCodeModelSwitch",
  "publisher": "xinzhaodc",
  "version": "0.1.0"
}
```

必须确认：

1. `publisher` 属于你的 Marketplace publisher 账号。
2. 扩展名称和显示名称不会冒充其他项目。
3. `repository`、`homepage` 和问题反馈地址是否适合公开用户。
4. README、LICENSE、CHANGELOG 和图标已准备好。
5. VSIX 不含 key、私有配置、日志、测试数据或内部路径之外的敏感信息。
6. 先完成 sandbox 和真实配置隔离测试，再考虑公开发布。

Publisher ID 创建后不应随意修改。发布账号、令牌和组织权限属于账号
管理范围，不写入仓库文件。

## 本地手动发布

在独立环境中执行：

```bash
cd "$VSCODEMODELSWITCH_ROOT"
npm ci
npm run check
npm run compile
npm run package
vsce publish
```

首次发布前需要在 Marketplace 管理页面创建 publisher，并按照官方流程
配置发布凭据。不要在 shell 历史、README、GitHub Actions 日志或项目配置
中打印令牌。

## GitHub Actions 自动发布

推荐只在版本 tag 上发布，例如：

```text
v0.1.1
v0.2.0
```

典型流水线顺序：

```text
checkout
  → setup Node 22
  → npm ci
  → npm run check
  → npm run compile
  → vsce publish
```

Marketplace 凭据放在 GitHub Actions Secrets 或官方推荐的安全身份机制
中。工作流只读取 Secret，不把值写入文件或输出到日志。

版本发布前应先人工安装同一版本 VSIX，确认扩展 ID、命令、配置迁移和
回滚行为正常，再创建 tag。

## 更新和回滚

每次发布必须提升 SemVer 版本号。VS Code 依据 Marketplace 中的版本号
判断更新，不依据 Git commit 时间判断。

出现问题时：

1. 立即停止继续发布。
2. 在 Marketplace 中处理错误版本的可见性。
3. 修复后发布更高版本号，不能重复覆盖同一版本。
4. 保留旧 VSIX 和对应 Git tag 作为本地回滚证据。

正式发布流程以 [VS Code 官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
和 [扩展市场更新说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
为准。
