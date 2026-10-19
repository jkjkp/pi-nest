# Pi Nest

Pi Nest 是运行在本机的 Pi 编程 Agent Web 工作台。你可以在浏览器中打开本地项目、与 Agent 对话、查看工具执行过程，并继续已有的 Pi 会话。

项目使用 Pi 原生会话、模型配置和认证信息，与 Pi CLI 共用数据。Pi 负责执行 Agent 任务，Pi Nest 提供项目导航、对话界面和设置入口。

## 主要功能

- **按项目管理对话**：打开已有目录或新建项目，查看、重命名和管理历史会话。
- **在浏览器中使用 Agent**：流式显示回答、思考内容与工具执行过程，支持停止任务、补充消息和引导当前任务。
- **阅读与整理会话**：查看历史、定位对话轮次、压缩上下文，以及分叉或复制会话。
- **发送附件与预览文件**：支持图片和普通文件附件，查看文本、代码及图片预览。
- **管理 Pi 配置**：通过界面切换模型和思考等级，配置 API 认证、自定义模型、MCP 服务及扩展资源。

## 环境要求

- Node.js **22.19.0 或更高版本**。
- pnpm **12.4.2**，与 `package.json` 中的 `packageManager` 一致。
- 一个浏览器，以及可用的模型提供商凭据或本地模型服务。

Pi 已作为项目依赖安装，无需另行全局安装。若已使用 Pi CLI，Pi Nest 会读取相同的原生配置和历史会话。

## 安装与运行

进入包含本 README 和 `package.json` 的 `pi-nest-app/` 目录，执行：

```bash
pnpm install
pnpm start
```

启动完成后，在浏览器打开 **[http://localhost:31415](http://localhost:31415)**。

`pnpm start` 会先构建所有包，再启动本地服务，同时提供页面、API 和 WebSocket。服务监听 `127.0.0.1:31415`。`pnpm dev`、`pnpm start:local` 与此入口相同。

日常使用时，修改源码或重新构建不会自动替换当前页面。需要使用更新后的代码时，等待 Agent 任务结束，在终端按 `Ctrl+C` 停止服务，再运行 `pnpm start`。如果端口已被占用，先停止原有服务。

## 首次使用

1. 打开页面，进入“设置 → API 与认证”，选择提供商并保存 API Key。已有 Pi 配置可直接复用；兼容端点或本地模型可在“自定义模型”中配置。
2. 返回首页，通过“打开项目”输入已有目录的绝对路径，或通过“新建项目”创建目录。路径对应运行 Pi Nest 服务的电脑。macOS 还支持系统文件夹选择器。
3. 在新对话中，通过输入框旁的选择器切换模型和思考等级，输入消息并发送。第一条消息发送时才创建 Pi 原生会话。
4. 后续从侧栏选择项目和历史会话，继续对话。

需要 OAuth 或订阅登录的提供商，请先在 Pi CLI 中使用 `/login` 完成认证。可在本工程目录通过项目自带的 Pi 启动终端界面：

```bash
pnpm --filter @pi-nest/pi-adapter exec pi
```

## 本地数据

- Pi 原生配置、认证与会话默认位于 `~/.pi/agent/`；设置 `PI_CODING_AGENT_DIR` 可指定其他 Pi 数据目录。
- Pi Nest 的项目登记、附件和界面投影缓存默认位于 `~/.pi-nest/`。
- 从侧栏移除项目只会隐藏入口，不会删除项目目录或原生会话，可在“设置 → 项目管理”中恢复。

## 开发

需要前端热更新时，在工程目录执行：

```bash
pnpm build
pnpm dev:hmr
```

打开 **[http://localhost:5173](http://localhost:5173)**。Vite 将 API 和 WebSocket 请求转发到本地 `31415` 服务。启动前需停止占用该端口的日常运行服务。

此模式下前端源码修改会触发热更新或页面重载；服务端没有自动重启，修改服务端代码后需手动重启。日常 Agent 对话建议使用 `pnpm start`。

常用检查命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

工程目录：

```text
apps/web/             React + Vite 浏览器界面
apps/server/          本地 Node.js 服务、API 与 WebSocket
packages/pi-adapter/  Pi 原生会话、配置与 CLI RPC 接入
packages/contracts/   前后端共享类型和数据契约
scripts/              本地启动与 Web 发布资源管理
```

需求、架构及开发记录见外层 [项目文档索引](../项目文档/INDEX.md)。

## 许可证

[Apache License 2.0](LICENSE)
