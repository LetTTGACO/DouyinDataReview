# 独立桌面调试环境

从源码运行 Electron 时，可以通过 `DY2_DEV_USER_DATA` 指定独立的数据目录，与已安装应用同时运行。

先安装依赖并构建 Web，再从项目根目录启动：

```bash
npm ci
npm run build:web
DY2_DEV_USER_DATA="$PWD/.local-data/desktop-debug-profile" npx electron desktop/main.mjs
```

此环境变量仅在未打包的源码模式生效。设置后，应用名称为 `DouyinDataReview Dev`，应用 ID 使用 `.dev` 后缀；页面与采集器分别优先监听 47661、47662，用户数据和浏览器会话保存在指定目录内。未设置时沿用原有名称、数据目录和 47651、47652 端口。

更改前端后需要重新构建 Web 产物，再重启调试版。原版应用与调试版分别保存数据。

调试版 MCP 可通过源码中的 stdio 桥接连接：

```bash
DY2_MCP_URL="http://127.0.0.1:47662/mcp" \
DY2_MCP_TOKEN_FILE="$PWD/.local-data/desktop-debug-profile/collector/mcp-token" \
node collector/mcpStdio.mjs
```

保持调试版打开。桥接脚本读取该数据目录中的令牌，转发到对应采集器。

## macOS 本地稳定版升级（命令行）

上游更新以正式发布的版本 Tag 为基准。合入前核对目标 Tag；由于曾撤销一次上游 main 合并，后续合入包含该合并的 Tag 时，需核对实际文件差异，确保目标版本的改动完整进入。

本地稳定版升级默认直接使用命令行完成构建、备份、退出进程、替换程序和重启，并以实际 MCP 调用验收。源码调试版继续使用独立的数据目录。

1. 在发布工作树运行 `EXPO_NO_TELEMETRY=1 npm run desktop:build:mac`，再用 `scripts/verify-release-package.mjs` 校验新 App 的 `Contents/Resources`，用 `codesign --verify --deep --strict` 校验签名完整性。记录版本、源码提交及安装包校验和。
2. 通过 `app_overview` 记录当前账号和运行状态，使用 `stop_reading` 暂停仍在运行的记录读取与聊天接收，等待数据落盘。保存升级前的记录与消息 ID，供升级后比对。
3. 用 `lsof` 按正式版采集器端口定位监听进程，再用 `ps` 核对其可执行文件路径。仅退出核对过的正式版进程，并确认进程退出、端口释放。
4. 备份旧 App 和整个 `~/Library/Application Support/内容数据工作台/collector/`。用 `ditto` 将新 App 复制到应用程序目录中的临时路径，校验后替换 `/Applications/DouyinDataReview.app`；替换失败时恢复旧 App。沿用原账号、登录凭据、群聊白名单及 MCP 令牌。
5. 用 `open -a /Applications/DouyinDataReview.app` 重启，核对安装版本、服务健康和已安装资源。通过现有 MCP 配置的实际命令、参数和环境变量验证 `initialize`、`tools/list` 及本次修改的工具返回；涉及聊天时使用已有本地消息验证。
6. 确认原账号和历史记录仍在，恢复升级前开启的聊天接收并检查连接状态。将备份位置、安装版本及 MCP 验证结果记入本地升级记录。
