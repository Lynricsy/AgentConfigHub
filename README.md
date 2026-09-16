# AgentConfigHub

[简体中文](README.zh-CN.md)

> A self-hosted control plane for securely editing, versioning, and distributing configuration across AI coding agents.

## Overview

AgentConfigHub is a personal, single-instance configuration control plane. Its server is the only source of truth: administrators create Agent configurations inside named configuration groups in a password-protected Web UI, publish each group as an immutable release, and approved devices pull those releases with a standalone CLI. Clients never upload local agent configuration.

中文运维指南：[Agent 操作手册（UltraServerUS）](docs/agent-operations.zh-CN.md)，覆盖文件、配置、密钥、共享资源、发布与回滚。

## Why AgentConfigHub

AI coding agents use different files, roots, formats, and authentication conventions. Copying configuration by hand makes drift, accidental secret exposure, and destructive overwrites likely. AgentConfigHub provides one explicit release boundary while retaining each agent's native file format.

## Features

- Named configuration groups as release and rollback boundaries, with one explicit configuration per Agent and `By group` / `By Agent` browsing
- Create-only `New` / `Upload` flows and uninterrupted Monaco autosave for native config files, plus direct revisioned editing of shared instructions and portable Agent Skills
- Envelope-encrypted blobs and credential revisions with format-aware secret slots
- Password-protected administration, one-time device pairing, and revocable automation tokens
- Transactional cross-platform installation with full backups, managed-file deletion safety, symlink/reparse-point refusal, and crash recovery
- Built-in adapters for six coding agents—including managed OMP MCP configuration—and a pull-only CLI packaged for `npx`

## Self-host with Docker Compose

Requirements: Docker with Compose v2 and a reverse proxy for non-loopback deployments. The public GHCR image supports `linux/amd64` and `linux/arm64`.

```bash
curl -fsSLO https://raw.githubusercontent.com/Lynricsy/AgentConfigHub/main/compose.example.yml
export AGENT_CONFIG_HUB_PUBLIC_URL=https://agents.example.com
export AGENT_CONFIG_HUB_MASTER_KEY="$(openssl rand -base64 32)"
docker compose -f compose.example.yml up -d
```

The example pulls `ghcr.io/lynricsy/agentconfighub:edge` and binds the service to `127.0.0.1:3000` by default. Override `AGENT_CONFIG_HUB_BIND_ADDRESS` only when the service must listen beyond the local reverse proxy. `edge` is mutable; reproducible production deployments should set:

```bash
export AGENT_CONFIG_HUB_IMAGE='ghcr.io/lynricsy/agentconfighub@sha256:a72acb520e9f5441eb877994842f87ac29cbaba1b4afb9dbbadb11f7b90fe11b'
```

The one-shot `initialize-data` service prepares `${AGENT_CONFIG_HUB_DATA_DIR:-./data}` for the non-root runtime UID `10001`; the application container then runs read-only with all Linux capabilities dropped. Preserve both the data directory and master key. Losing the key makes encrypted credentials and blobs unrecoverable.

For a local source build instead, use `docker compose up --build -d` with `compose.yaml`. Local-only evaluation accepts `http://127.0.0.1:<port>`; every non-loopback public URL must use HTTPS. If a reverse proxy supplies forwarding headers, set `AGENT_CONFIG_HUB_TRUST_PROXY` to an explicit comma-separated IP/CIDR allowlist, never a blanket trust value.

| Environment variable | Purpose |
| --- | --- |
| `AGENT_CONFIG_HUB_IMAGE` | Optional GHCR tag or digest; defaults to `edge` |
| `AGENT_CONFIG_HUB_PUBLIC_URL` | Required canonical URL; HTTPS except loopback |
| `AGENT_CONFIG_HUB_MASTER_KEY` | Required base64-encoded 32-byte master key |
| `AGENT_CONFIG_HUB_DATA_DIR` | Host bind path in Compose; defaults to `./data` |
| `AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN` | Optional first-run setup code |
| `AGENT_CONFIG_HUB_TRUST_PROXY` | Optional explicit proxy IP/CIDR list |
| `AGENT_CONFIG_HUB_BIND_ADDRESS` | Host bind address; defaults to `127.0.0.1` |
| `AGENT_CONFIG_HUB_PORT` | Host port exposed by Compose; defaults to `3000` |

## CLI

The pull-only CLI is published as [`agent-config-hub`](https://www.npmjs.com/package/agent-config-hub). Run commands with `npx --yes agent-config-hub@latest`, or install it globally with `npm install --global agent-config-hub`.

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

`login` performs browser-approved device pairing. `AGENT_CONFIG_HUB_SERVER` and `AGENT_CONFIG_HUB_TOKEN` override stored credentials for automation without placing the token in argv. A pull validates the immutable manifest, streams and hashes downloads, stages same-filesystem replacements, backs up overwritten/deleted managed files, and commits through a durable journal.

每个发布版本都会记录最低 CLI 版本。OMP adapter revision 5 新增了 `omp-notify.json` 受管面，新发布要求 CLI `0.2.3` 及以上；旧 CLI 会在改动任何文件前拒绝拉取。CLI 要求适配器 revision 精确匹配，升级后应拉取由新版服务端重新发布的 OMP 配置，历史 OMP revision 4 的 Release 不能直接用新版 CLI 安装。

## Operations

- `GET /api/v1/health` returns success only after migrations, master-key loading, local-volume probing, and a live SQLite write-lock probe.
- Settings shows encrypted Blob statistics and exposes manual GC. The server also runs GC every 24 hours; unreferenced blobs retain a seven-day grace period.
- `SIGTERM`/`SIGINT` stops new requests, drains in-flight work through Fastify close, clears maintenance timers, and then closes SQLite.

## Supported Agents

The built-in adapter set targets Claude Code, OpenAI Codex, OpenCode, Pi Coding Agent, Oh My Pi (OMP), and Grok Build. Each adapter declares the exact surfaces it manages, including a root `.env` file with dotenv validation. OMP also covers `config.yml`, `models.yml`, `keybindings.yml`/`.json`, `mcp.json`, the `*.md` instruction files, and the `skills`, `commands`, `rules`, `prompts`, `role-prompts`, `instructions`, `hooks`, `tools`, and `extensions` directories.

OMP 还支持根目录 `omp-notify.json`，按 JSON 校验，可使用完整标量 `{{secret:SLOT_NAME}}` 配置 Telegram 凭据；不放宽其他根目录 JSON 文件的路径限制。

设备登记名称可作为完整字符串变量 `{{device:name}}` 使用，例如 OMP `omp-notify.json` 中的 `"device_name": "{{device:name}}"`。它取自当前拉取令牌对应设备注册时填写的名称，不是本机 hostname，也不是自动化令牌标签；环境变量覆盖令牌时同样使用该令牌的鉴权身份。只支持 JSON/JSONC/YAML/TOML/dotenv 的完整字符串值，禁止拼接、键名、注释和未知设备变量。

含设备变量的新 Release 要求 CLI `0.2.4`，其他新 Release 保持最低 `0.2.3`，OMP adapter revision 仍为 5。CLI 先校验不可变原始下载的大小和 SHA-256，再按发布时冻结的精确位置替换；秘密值和设备名内的占位符不会递归展开。计划、安装状态、重复 pull 和 status 使用实际落盘字节的哈希。自动化令牌可以拉取无设备变量的配置，但需要设备名时明确失败。dotenv 无法无损表达的名称（如冲突引号组合、回车或 NUL）会在写目标前拒绝；不会偷偷改名。

## Architecture

- `apps/server` — Fastify API, SQLite metadata, encrypted blob storage, authentication, and release orchestration
- `apps/web` — React and Vite single-page administration UI; Tailwind CSS v4 with `oklch` semantic tokens and Radix Primitives components in `src/ui` (shadcn/ui pattern, code lives in the repository); light/dark/system theming persisted in `localStorage` under `agch-theme`; Inter + JetBrains Mono, `lucide-react` icons, `sonner` toasts; native scrolling — `AppShell` renders a single bounded `<main>` scroll port, no scroll library
- `packages/protocol` — shared Zod wire contracts
- `packages/adapters` — shared agent validation, rendering, and local path safety
- `packages/cli` — standalone pull-only npm CLI

Production serves the Web build from the server. All API routes are versioned under `/api/v1`.

## Security Model

The server is authoritative and clients are pull-only. Secrets are entered through structured credential forms, encrypted with per-record data keys, and frozen into exact release outputs. Tokens are stored server-side only as hashes. Release manifests contain logical targets rather than server or client absolute paths. The CLI limits writes and deletions to adapter-approved targets it can prove are managed.

## Release Status

Web production E2E, authentication/encryption integration, six-adapter contracts, real packaged `npx` pulls, crash recovery, Blob GC, and non-root Compose startup have executable coverage. The CLI is published on npm; container images are published to GHCR with build attestations. APIs may still change, and adapter surface changes bump the adapter revision together with the release CLI floor.

## License

[MIT](LICENSE) © 2026 Lynricsy
