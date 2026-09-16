# AgentConfigHub

[English](README.md)

> 一个用于安全编辑、版本化并向多种 AI 编程 Agent 分发配置的自托管控制平面。

## 概览

AgentConfigHub 是面向个人部署的单实例配置控制平面。服务端是唯一事实源：管理员在密码保护的 Web UI 中为命名配置组创建各 Agent 配置，以配置组为边界发布不可变版本，再由获批设备通过独立 CLI 拉取。客户端从不上传本机 Agent 配置。

已部署实例的配置管理见 [Agent 操作手册（UltraServerUS）](docs/agent-operations.zh-CN.md)：新增文件、编辑配置、密钥绑定与轮换、共享指令/Skill、发布验证和回滚。

## 为什么选择 AgentConfigHub

不同 AI 编程 Agent 使用不同文件、根目录、格式与认证约定。手工复制配置容易造成漂移、秘密意外泄露和破坏性覆盖。AgentConfigHub 在保留各 Agent 原生格式的同时，提供明确的统一发布边界。

## 功能

- 以命名配置组作为发布与回滚边界，每个 Agent 对应一个明确配置，并支持按配置组或 Agent 浏览
- 原生配置文件采用不覆盖已有文件的 `New` / `Upload` 创建流程和不中断输入焦点的 Monaco 自动保存，共享 instructions 与可移植 Agent Skills 则支持直接修订编辑
- 带格式感知秘密槽位的信封加密 Blob 与凭据修订
- 密码保护管理端、一次性设备配对和可撤销自动化令牌
- 带完整备份、受管删除保护、链接/reparse point 拒绝和崩溃恢复的跨平台事务安装
- 六个内置 Agent 适配器（包括受管 OMP MCP 配置），以及为 `npx` 打包的只拉取 CLI

## 使用 Docker Compose 自托管

需要 Docker Compose v2；非本机回环部署还需要负责 HTTPS 终止的反向代理。公开 GHCR 镜像支持 `linux/amd64` 与 `linux/arm64`。

```bash
curl -fsSLO https://raw.githubusercontent.com/Lynricsy/AgentConfigHub/main/compose.example.yml
export AGENT_CONFIG_HUB_PUBLIC_URL=https://agents.example.com
export AGENT_CONFIG_HUB_MASTER_KEY="$(openssl rand -base64 32)"
docker compose -f compose.example.yml up -d
```

示例默认拉取 `ghcr.io/lynricsy/agentconfighub:edge`，并把服务绑定到 `127.0.0.1:3000`。只有服务确实需要越过本机反向代理监听时，才应覆盖 `AGENT_CONFIG_HUB_BIND_ADDRESS`。`edge` 是可变标签；生产环境若要求可复现部署，应设置：

```bash
export AGENT_CONFIG_HUB_IMAGE='ghcr.io/lynricsy/agentconfighub@sha256:a72acb520e9f5441eb877994842f87ac29cbaba1b4afb9dbbadb11f7b90fe11b'
```

一次性 `initialize-data` 服务会先为非 root 运行时 UID `10001` 准备 `${AGENT_CONFIG_HUB_DATA_DIR:-./data}`；随后应用容器以只读根文件系统、无 Linux capability 的方式运行。请同时备份数据目录与主密钥；丢失主密钥后，加密凭据和 Blob 无法恢复。

如需从本地源码构建，请改用 `compose.yaml` 执行 `docker compose up --build -d`。本机评估允许 `http://127.0.0.1:<port>`；所有非回环公开 URL 必须使用 HTTPS。若反向代理提供转发头，请把 `AGENT_CONFIG_HUB_TRUST_PROXY` 设置为逗号分隔的明确 IP/CIDR 白名单，绝不能信任任意代理。

| 环境变量 | 用途 |
| --- | --- |
| `AGENT_CONFIG_HUB_IMAGE` | 可选 GHCR 标签或摘要；默认使用 `edge` |
| `AGENT_CONFIG_HUB_PUBLIC_URL` | 必填规范 URL；除回环外必须 HTTPS |
| `AGENT_CONFIG_HUB_MASTER_KEY` | 必填 Base64 编码 32 字节主密钥 |
| `AGENT_CONFIG_HUB_DATA_DIR` | Compose 宿主机绑定路径；默认 `./data` |
| `AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN` | 可选首次初始化码 |
| `AGENT_CONFIG_HUB_TRUST_PROXY` | 可选明确代理 IP/CIDR 列表 |
| `AGENT_CONFIG_HUB_BIND_ADDRESS` | 宿主机绑定地址；默认 `127.0.0.1` |
| `AGENT_CONFIG_HUB_PORT` | Compose 暴露的宿主机端口；默认 `3000` |

## CLI

只读拉取 CLI 以 [`agent-config-hub`](https://www.npmjs.com/package/agent-config-hub) 发布。可用 `npx --yes agent-config-hub@latest` 直接运行，或通过 `npm install --global agent-config-hub` 全局安装。

```text
agent-config-hub login --server <url> [--name <device>]
agent-config-hub logout
agent-config-hub config-sets
agent-config-hub pull --profile <slug> [--agent <id>...] [--dry-run]
  [--target-root <root>=<path>] [--replace-symlink] [--force-remove-modified]
agent-config-hub status --profile <slug>
agent-config-hub backups list|restore <id>|delete <id>
agent-config-hub roots list|set <root-id> <absolute-path>|reset <root-id>
```

`login` 执行浏览器审批的设备配对。自动化可用 `AGENT_CONFIG_HUB_SERVER` 和 `AGENT_CONFIG_HUB_TOKEN` 覆盖本地凭据，令牌无需进入 argv。拉取会校验不可变清单、流式下载并计算哈希、在同文件系统 staging、备份被覆盖/删除的受管文件，再通过持久 journal 提交。

每个发布版本都会记录最低 CLI 版本。OMP adapter revision 5 新增了 `omp-notify.json` 受管面，新发布要求 CLI `0.2.3` 及以上；旧 CLI 会在改动任何文件前拒绝拉取。CLI 要求适配器 revision 精确匹配，升级后应拉取由新版服务端重新发布的 OMP 配置，历史 OMP revision 4 的 Release 不能直接用新版 CLI 安装。

## 运维

- `GET /api/v1/health` 只在迁移、主密钥加载、本地卷探测和实时 SQLite 写锁探针均正常后成功。
- 设置页展示加密 Blob 统计并支持手动 GC；服务端每 24 小时自动运行 GC，未引用 Blob 保留七天宽限期。
- `SIGTERM`/`SIGINT` 会停止新请求，通过 Fastify close 排空进行中工作，清理维护计时器后再关闭 SQLite。

## 支持的 Agent

内置适配器目标为 Claude Code、OpenAI Codex、OpenCode、Pi Coding Agent、Oh My Pi（OMP）和 Grok Build。每个适配器都显式声明自己管理的文件面，包括经过 dotenv 校验的根目录 `.env` 文件。OMP 还覆盖 `config.yml`、`models.yml`、`keybindings.yml`/`.json`、`mcp.json`、各 `*.md` 指令文件，以及 `skills`、`commands`、`rules`、`prompts`、`role-prompts`、`instructions`、`hooks`、`tools`、`extensions` 目录。

OMP 还支持根目录 `omp-notify.json`，按 JSON 校验，可使用完整标量 `{{secret:SLOT_NAME}}` 配置 Telegram 凭据；不放宽其他根目录 JSON 文件的路径限制。

设备登记名称可作为完整字符串变量 `{{device:name}}` 使用，例如 OMP `omp-notify.json` 中的 `"device_name": "{{device:name}}"`。它取自当前拉取令牌对应设备注册时填写的名称，不是本机 hostname，也不是自动化令牌标签；环境变量覆盖令牌时同样使用该令牌的鉴权身份。只支持 JSON/JSONC/YAML/TOML/dotenv 的完整字符串值，禁止拼接、键名、注释和未知设备变量。

含设备变量的新 Release 要求 CLI `0.2.4`，其他新 Release 保持最低 `0.2.3`，OMP adapter revision 仍为 5。CLI 先校验不可变原始下载的大小和 SHA-256，再按发布时冻结的精确位置替换；秘密值和设备名内的占位符不会递归展开。计划、安装状态、重复 pull 和 status 使用实际落盘字节的哈希。自动化令牌可以拉取无设备变量的配置，但需要设备名时明确失败。dotenv 无法无损表达的名称（如冲突引号组合、回车或 NUL）会在写目标前拒绝；不会偷偷改名。

## 架构

- `apps/server` — Fastify API、SQLite 元数据、加密 Blob 存储、认证与发布编排
- `apps/web` — React + Vite 单页管理界面；Terminal Brutalism 设计系统（Space Grotesk + JetBrains Mono、`lucide-react` 图标、`motion` 弹簧动效）；Lenis 平滑滚动由 `AppShell` 的 `useEffect` 管理，`prefers-reduced-motion` 下不启用
- `packages/protocol` — 共享 Zod 线路协议
- `packages/adapters` — 共享 Agent 校验、渲染与本地路径安全
- `packages/cli` — 独立、只拉取的 npm CLI

生产环境由服务端托管 Web 构建产物；所有 API 固定在 `/api/v1` 下。

## 安全模型

服务端具有权威性，客户端只允许拉取。秘密通过结构化凭据表单录入，以每条记录独立数据密钥加密，并冻结为精确发布输出。服务端只保存令牌哈希。发布清单仅含逻辑目标，不包含服务端或客户端绝对路径。CLI 只会写入和删除适配器许可且可证明由其管理的目标。

## 发布状态

生产 Web E2E、认证/加密集成、六适配器契约、真实打包 `npx` 拉取、崩溃恢复、Blob GC 和非 root Compose 启动均有可执行覆盖。CLI 已发布到 npm，容器镜像连同构建证明发布到 GHCR。API 仍可能调整；适配器受管面变化会同时抬高 adapter revision 与发布的最低 CLI 版本。

## 许可证

[MIT](LICENSE) © 2026 Lynricsy
