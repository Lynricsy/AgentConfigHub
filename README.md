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
- Envelope-encrypted blobs and credential revisions with format-aware secret slots; rollbacks pin bindings to the released credential revision (shown as `Pinned to rN`), and rotating a credential releases those pins so the next publish uses the new value ([operations guide](docs/agent-operations.zh-CN.md#54-轮换密钥))
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

In a terminal (stdout is a TTY) the CLI renders colored tables, a boxed device-authorization panel, and progress spinners, abbreviating home-directory paths as `~`; colors honor `NO_COLOR` / `FORCE_COLOR`. When stdout is piped or redirected it prints plain text; `pull`, `status`, and the tab-separated `config-sets`, `backups list`, and `roots list` output are unchanged so scripts keep working. Spinners only ever write to stderr.

Every release records a minimum CLI version. OMP adapter revision 6 adds the `cortexkit-home` root and the `agent-config-hub.json` extras declaration, so every new release requires CLI `0.3.0`; older CLIs refuse before touching any file. The CLI requires an exact adapter revision match, so upgrade the CLI, deploy the new server, and republish before clients pull; releases published under OMP revision 5 cannot be installed by CLI `0.3.0`.

### OMP extras: plugins and skill repositories

An OMP config may publish `omp-home/agent-config-hub.json`. After a successful pull writes the release (and on every later pull), the CLI runs `omp plugin install <spec>` for each plugin and clones or fast-forwards each skill repository into `<omp-home>/skill-repositories/<name>`. `--dry-run` prints the plan without running anything.

```json
{
  "version": 1,
  "plugins": ["@cortexkit/pi-magic-context@latest"],
  "skillRepositories": [
    { "name": "hyperskills", "url": "https://github.com/Lynricsy/HyperSkills.git", "ref": "main" }
  ]
}
```

Point OMP at the cloned skills from the managed `config.yml`, e.g. `skills.customDirectories: ["~/.omp/agent/skill-repositories/hyperskills/skills"]`. Plugins are npm specs (use `@latest` to follow new versions); repositories must be `https://` URLs without embedded credentials and a branch or tag `ref`. Nothing is passed through a shell. Updates are strict fast-forwards: a clone with uncommitted changes, local commits, rewritten upstream history, or a different `origin` is never overwritten; the pull reports the error and exits non-zero while the already installed files stay in place. `omp` and `git` must be on `PATH`.

## Operations

- `GET /api/v1/health` returns success only after migrations, master-key loading, local-volume probing, and a live SQLite write-lock probe.
- Settings shows encrypted Blob statistics and exposes manual GC. The server also runs GC every 24 hours; unreferenced blobs retain a seven-day grace period.
- `SIGTERM`/`SIGINT` stops new requests, drains in-flight work through Fastify close, clears maintenance timers, and then closes SQLite.

## Supported Agents

The built-in adapter set targets Claude Code, OpenAI Codex, OpenCode, Pi Coding Agent, Oh My Pi (OMP), and Grok Build. Each adapter declares the exact surfaces it manages, including a root `.env` file with dotenv validation. OMP also covers `config.yml`, `models.yml`, `keybindings.yml`/`.json`, `mcp.json`, `omp-notify.json`, `agent-config-hub.json`, the `*.md` instruction files, and the `skills`, `commands`, `rules`, `prompts`, `role-prompts`, `instructions`, `hooks`, `tools`, and `extensions` directories.

OMP owns a second root, `cortexkit-home` (default `~/.config/cortexkit`), that manages only the Magic Context user config `magic-context.jsonc`. It accepts full-scalar `{{secret:SLOT_NAME}}` placeholders such as the embedding `api_key`. Devices that set `XDG_CONFIG_HOME` should run `agent-config-hub roots set cortexkit-home "$XDG_CONFIG_HOME/cortexkit"`.

`omp-notify.json` is validated as JSON and may use full-scalar `{{secret:SLOT_NAME}}` placeholders for Telegram credentials; other root JSON paths stay unmanaged.

设备登记名称可作为完整字符串变量 `{{device:name}}` 使用，例如 OMP `omp-notify.json` 中的 `"device_name": "{{device:name}}"`。它取自当前拉取令牌对应设备注册时填写的名称，不是本机 hostname，也不是自动化令牌标签；环境变量覆盖令牌时同样使用该令牌的鉴权身份。只支持 JSON/JSONC/YAML/TOML/dotenv 的完整字符串值，禁止拼接、键名、注释和未知设备变量。

Releases with device variables no longer have a separate floor: every new release requires CLI `0.3.0`. The CLI verifies the immutable original download's size and SHA-256 before replacing the frozen exact positions; placeholders inside secret values or device names are never expanded recursively. Plans, install state, repeated pulls, and status use the hash of the bytes actually written. Automation tokens can pull configs without device variables but fail explicitly when a device name is required. Names that dotenv cannot represent losslessly (conflicting quote combinations, carriage returns, NUL) are rejected before any target is written; they are never silently renamed.

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
