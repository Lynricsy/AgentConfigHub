# AgentConfigHub

[English](README.md)

> 一个用于安全编辑、版本化并向多种 AI 编程 Agent 分发配置的自托管控制平面。

## 概览

AgentConfigHub 是面向个人部署的单实例配置控制平面。服务端是唯一事实源：管理员在密码保护的 Web UI 中编辑命名配置集，发布不可变版本，再由获批设备通过独立 CLI 拉取。客户端从不上传本机 Agent 配置。

## 为什么选择 AgentConfigHub

不同 AI 编程 Agent 使用不同文件、根目录、格式与认证约定。手工复制配置容易造成漂移、秘密意外泄露和破坏性覆盖。AgentConfigHub 在保留各 Agent 原生格式的同时，提供明确的统一发布边界。

## 功能

AgentConfigHub 正在积极开发。目标版本包括：

- 相互独立的命名配置集、不可变发布与回滚
- 基于信封加密的 Blob 与凭据修订
- 密码保护的管理端和一次性设备配对审批
- 带备份和受管文件保护的跨平台事务安装
- 原生文件编辑、共享 instructions 与可移植 Agent Skills
- 可通过 `npx agent-config-hub` 运行的只拉取 CLI

命令和部署说明会在对应端到端路径验证后补充。

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

## 开发状态

本仓库正依据已批准的实施计划开发。在对应自动化与端到端验证通过前，公开 API、npm 安装、容器部署和运维命令均不视为已发布能力。

## 许可证

[MIT](LICENSE) © 2026 Lynricsy
