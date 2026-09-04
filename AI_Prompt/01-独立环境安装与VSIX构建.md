# 独立环境、依赖安装与 VSIX 构建

## 适用范围

本项目是 Forest_Interface 中独立维护的 VS Code 扩展源码。源码位于：

```text
/home/workspace/Forest_Interface/code/VSCodeModelSwitch
```

Node.js 运行时由 Forest_Interface 公共环境管理，固定 prefix 为：

```text
/home/workspace/Forest_Interface/environment/prefixes/vscodemodelswitch-node22
```

项目 npm 依赖仍然属于本项目，安装在源码目录的 `node_modules/`，由
`package-lock.json` 锁定。`original/` 只用于对照，不参与构建。

## 从零制作独立环境

### 1. 固定环境边界

本环境由四部分组成：

```text
environment/profiles/vscodemodelswitch/       维护型 profile、入口和锁定信息
environment/prefixes/vscodemodelswitch-node22 Node.js/npm 运行时 prefix
code/VSCodeModelSwitch/                       源码和 package-lock.json
code/VSCodeModelSwitch/node_modules/          项目依赖，可由 npm ci 重建
```

入口脚本只负责检查和加载已有 prefix。下载、解包、依赖安装、编译和打包
都必须在入口之外由用户分批执行。

### 2. 下载并校验 Node.js

当前目标为 Linux x64 Node.js `22.14.0`。先准备临时目录和压缩包：

```bash
NODE_VERSION=22.14.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
DOWNLOAD_NODE_DIR="$(mktemp -d)"

curl -fL --retry 3 --connect-timeout 15 --show-error \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  -o "$DOWNLOAD_NODE_DIR/$NODE_ARCHIVE"

curl -fL --retry 3 --connect-timeout 15 --show-error \
  "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  -o "$DOWNLOAD_NODE_DIR/SHASUMS256.txt"
```

校验时必须在压缩包所在目录执行，避免 `sha256sum -c` 按错误的当前目录找文件：

```bash
(
  cd "$DOWNLOAD_NODE_DIR" || exit 1
  grep -F "$NODE_ARCHIVE" SHASUMS256.txt
  grep -F "$NODE_ARCHIVE" SHASUMS256.txt | sha256sum -c -
)
```

应显示：

```text
node-v22.14.0-linux-x64.tar.xz: OK
```

校验失败时停止，不能解包或覆盖 prefix。下载目录中可能存在重复压缩包，
必须先比较大小和 SHA-256，不能按路径猜测。

### 3. 解包到固定 prefix

确认目标目录为空或不存在后执行：

```bash
NODE_PREFIX=/home/workspace/Forest_Interface/environment/prefixes/vscodemodelswitch-node22

if find "$NODE_PREFIX" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
  printf 'Prefix is not empty; stop without overwriting: %s\n' "$NODE_PREFIX" >&2
else
  mkdir -p "$NODE_PREFIX"
  tar -xJf "$DOWNLOAD_NODE_DIR/$NODE_ARCHIVE" \
    --strip-components=1 \
    -C "$NODE_PREFIX"
  "$NODE_PREFIX/bin/node" --version
  PATH="$NODE_PREFIX/bin:$PATH" npm --version
fi
```

确认 `node` 和 `npm` 都能执行后，把 Node 版本、压缩包名称和 SHA-256
写入 `environment/profiles/vscodemodelswitch/versions.lock`。prefix 已存在
但不是完整安装时，不要重新解包覆盖；先保留现场并检查目录内容。

### 4. 制作 profile 和公共入口

新增或迁移一个 Interface 环境时，需要同时完成：

1. 在 `profiles/vscodemodelswitch/setup.sh` 中声明源码根和固定 prefix，检查
   `package.json` 可读、`bin/node` 和 `bin/npm` 可执行，再导出 PATH。
2. 在 `profiles/vscodemodelswitch/enter.sh` 中调用公共
   `lib/launch_clean_shell.sh vscodemodelswitch`。
3. 在 `lib/launch_clean_shell.sh` 的 profile case 中注册 setup 路径。
4. 在 `environment/shell_entries.sh` 中注册短命令
   `enter-vscodemodelswitch`。
5. 在 `manifest.md`、`versions.lock`、环境索引和本文件中记录路径、版本、
   生命周期和未验证门禁。

公共入口不得执行 `apt`、`curl`、`npm ci`、`npm run compile`、`vsce package`，
也不得启动 VS Code、Claude、Codex 或 mock 服务。

### 5. 安装项目依赖

进入 child shell 后，在源码根执行：

```bash
cd "$VSCODEMODELSWITCH_ROOT"
npm ci
```

依赖属于源码项目，不复制到公共 Node prefix。更新依赖时必须有明确的依赖
升级目的，并重新生成锁文件和记录。

## 进入独立环境

在新终端执行：

```bash
source /home/workspace/Forest_Interface/environment/shell_entries.sh
enter-vscodemodelswitch
```

进入后确认：

```bash
node --version
npm --version
echo "$VSCODEMODELSWITCH_ROOT"
echo "$VSCODEMODELSWITCH_NODE_PREFIX"
```

预期源码路径为 `code/VSCodeModelSwitch`，Node 版本为 22.x。

入口只加载已存在的 Node/npm，不会自动下载、安装、编译或启动 VS Code。
退出 child shell 使用：

```bash
exit
```

## 首次安装项目依赖

进入 child shell 后执行：

```bash
cd "$VSCODEMODELSWITCH_ROOT"
npm ci
```

`npm ci` 会根据 `package-lock.json` 重建 `node_modules/`。不要用普通
`npm install` 修改锁文件，除非任务本身就是依赖升级。

## 检查、编译和打包

```bash
npm run check
npm run compile
npm run package
```

作用分别是：

- `check`：TypeScript 类型检查，不生成发布文件。
- `compile`：生成 `out/` 和 Source Map。
- `package`：使用 `vsce` 生成 VSIX。

成功产物为：

```text
/home/workspace/Forest_Interface/code/VSCodeModelSwitch/vscodemodelswitch-<version>.vsix
```

可用以下命令检查包内容：

```bash
vsce ls --tree
```

发布包不得包含 API key、SecretStorage 数据、sandbox 配置、临时日志或
`node_modules/`。

## 从 VSIX 安装

优先使用 VS Code 图形界面：

```text
Extensions → ... → Install from VSIX...
```

也可以使用 VS Code Server 的绝对路径 CLI。当前容器的活动版本示例为：

```bash
CODE_CLI=/root/.vscode-server/bin/520fb30b2d3d324b4cb2342f6e88e2cd93751de1/bin/remote-cli/code
VSIX_PATH="$VSCODEMODELSWITCH_ROOT/vscodemodelswitch-<version>.vsix"
"$CODE_CLI" --install-extension "$VSIX_PATH" --force
```

如果 `code` 命令不存在，不要安装 Ubuntu 软件源中的旧版本；使用 VS Code
Server 对应的 `remote-cli/code` 绝对路径，或使用图形界面安装。

安装后执行：

```text
Developer: Reload Window
```

确认原插件 `wanghryii.vsmodelswitch` 和私有插件
`xinzhaodc.vscodemodelswitch` 可以同时存在。

## GitHub 更新到本地 VSIX

当前分发方式不是 Marketplace，而是：

```text
GitHub 拉取源码
  → enter-vscodemodelswitch
  → npm ci
  → npm run check
  → npm run compile
  → npm run package
  → Install from VSIX
```

更新前保留当前可用的旧 VSIX，出现问题时重新安装旧 VSIX 回滚。每次功能
更新都应修改版本号，并在 `AI_Prompt/03-功能更新记录.md` 记录变更和验证
结果。

## 安全测试要求

首次运行和回归测试必须在 VS Code 设置中使用：

```json
{
  "vscodemodelswitch.configTarget": "sandbox"
}
```

这样 Apply 只写工作区下的 `.vscodemodelswitch-home`，不直接改动真实的
`~/.claude` 或 `~/.codex` 配置。
