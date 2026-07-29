# AgentConfigHub

[English](README.md)

> 一个用于安全编辑、版本化并向多种 AI 编程 Agent 分发配置的自托管控制平面。

## 概览

AgentConfigHub 是面向个人部署的单实例配置控制平面。服务端是唯一事实源：管理员在密码保护的 Web UI 中编辑命名配置集，发布不可变版本，再由获批设备通过独立 CLI 拉取。客户端从不上传本机 Agent 配置。

## 为什么选择 AgentConfigHub

不同 AI 编程 Agent 使用不同文件、根目录、格式与认证约定。手工复制配置容易造成漂移、秘密意外泄露和破坏性覆盖。AgentConfigHub 在保留各 Agent 原生格式的同时，提供明确的统一发布边界。

## 功能

- 相互独立的命名配置集、不可变发布与回滚
- 基于 Monaco 的原生文件编辑、诊断、共享 instructions 与可移植 Agent Skills
- 带格式感知秘密槽位的信封加密 Blob 与凭据修订
- 密码保护管理端、一次性设备配对和可撤销自动化令牌
- 带完整备份、受管删除保护、链接/reparse point 拒绝和崩溃恢复的跨平台事务安装
- 六个内置 Agent 适配器，以及为 `npx` 打包的只拉取 CLI

## 使用 Docker Compose 自托管

需要 Docker Compose v2；非本机回环部署还需要负责 HTTPS 终止的反向代理。

```bash
export AGENT_CONFIG_HUB_PUBLIC_URL=https://agents.example.com
export AGENT_CONFIG_HUB_MASTER_KEY="$(openssl rand -base64 32)"
docker compose up --build -d
```

一次性 `initialize-data` 服务会先为非 root 运行时 UID `10001` 准备 `${AGENT_CONFIG_HUB_DATA_DIR:-./data}`；随后应用容器以只读根文件系统、无 Linux capability 的方式运行。请同时备份数据目录与主密钥；丢失主密钥后，加密凭据和 Blob 无法恢复。

本机评估允许 `http://127.0.0.1:<port>`；所有非回环公开 URL 必须使用 HTTPS。若反向代理提供转发头，请把 `AGENT_CONFIG_HUB_TRUST_PROXY` 设置为逗号分隔的明确 IP/CIDR 白名单，绝不能信任任意代理。

| 环境变量 | 用途 |
| --- | --- |
| `AGENT_CONFIG_HUB_PUBLIC_URL` | 必填规范 URL；除回环外必须 HTTPS |
| `AGENT_CONFIG_HUB_MASTER_KEY` | 必填 Base64 编码 32 字节主密钥 |
| `AGENT_CONFIG_HUB_DATA_DIR` | Compose 宿主机绑定路径；默认 `./data` |
| `AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN` | 可选首次初始化码 |
| `AGENT_CONFIG_HUB_TRUST_PROXY` | 可选明确代理 IP/CIDR 列表 |
| `AGENT_CONFIG_HUB_PORT` | Compose 暴露的宿主机端口；默认 `3000` |

## CLI

软件包暴露 `agent-config-hub` 可执行文件。本源码版本尚未执行 npm registry 发布；打包 tarball 与工作区构建已通过真实 `npx` 安装验证。

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

## 运维

- `GET /api/v1/health` 只在迁移、主密钥加载、本地卷探测和实时 SQLite 写锁探针均正常后成功。
- 设置页展示加密 Blob 统计并支持手动 GC；服务端每 24 小时自动运行 GC，未引用 Blob 保留七天宽限期。
- `SIGTERM`/`SIGINT` 会停止新请求，通过 Fastify close 排空进行中工作，清理维护计时器后再关闭 SQLite。

## 支持的 Agent

内置适配器目标为 Claude Code、OpenAI Codex、OpenCode、Pi Coding Agent、Oh My Pi（OMP）和 Grok Build。

## 架构

- `apps/server` — Fastify API、SQLite 元数据、加密 Blob 存储、认证与发布编排
- `apps/web` — React + Vite 单页管理界面
- `packages/protocol` — 共享 Zod 线路协议
- `packages/adapters` — 共享 Agent 校验、渲染与本地路径安全
- `packages/cli` — 独立、只拉取的 npm CLI

生产环境由服务端托管 Web 构建产物；所有 API 固定在 `/api/v1` 下。

## 安全模型

服务端具有权威性，客户端只允许拉取。秘密通过结构化凭据表单录入，以每条记录独立数据密钥加密，并冻结为精确发布输出。服务端只保存令牌哈希。发布清单仅含逻辑目标，不包含服务端或客户端绝对路径。CLI 只会写入和删除适配器许可且可证明由其管理的目标。

## 发布状态

仓库现包含经验证的预发布实现：生产 Web E2E、认证/加密集成、六适配器契约、真实打包 `npx` 拉取、崩溃恢复、Blob GC 和非 root Compose 启动均有可执行覆盖。尚未执行 npm registry 发布；首次打标签发布前 API 仍可能调整。

## 许可证

[MIT](LICENSE) © 2026 Lynricsy
