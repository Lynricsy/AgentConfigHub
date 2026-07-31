# AgentConfigHub

[简体中文](README.zh-CN.md)

> A self-hosted control plane for securely editing, versioning, and distributing configuration across AI coding agents.

## Overview

AgentConfigHub is a personal, single-instance configuration control plane. Its server is the only source of truth: administrators create Agent configurations inside named configuration groups in a password-protected Web UI, publish each group as an immutable release, and approved devices pull those releases with a standalone CLI. Clients never upload local agent configuration.

## Why AgentConfigHub

AI coding agents use different files, roots, formats, and authentication conventions. Copying configuration by hand makes drift, accidental secret exposure, and destructive overwrites likely. AgentConfigHub provides one explicit release boundary while retaining each agent's native file format.

## Features

- Named configuration groups as release and rollback boundaries, with one explicit configuration per Agent and `By group` / `By Agent` browsing
- Create-only `New` / `Upload` file flows, Monaco-based native file editing, diagnostics, shared instructions, and portable Agent Skills
- Envelope-encrypted blobs and credential revisions with format-aware secret slots
- Password-protected administration, one-time device pairing, and revocable automation tokens
- Transactional cross-platform installation with full backups, managed-file deletion safety, symlink/reparse-point refusal, and crash recovery
- Built-in adapters for six coding agents and a pull-only CLI packaged for `npx`

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
export AGENT_CONFIG_HUB_IMAGE='ghcr.io/lynricsy/agentconfighub@sha256:a744d005ab92363fbd85c2c4933e3a1f45301a97e5c01f74f1b48d9004f1393d'
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

The package exposes the `agent-config-hub` binary. The registry publication is not part of this source release; the packaged tarball and workspace build have been verified through real `npx` installation.

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

## Operations

- `GET /api/v1/health` returns success only after migrations, master-key loading, local-volume probing, and a live SQLite write-lock probe.
- Settings shows encrypted Blob statistics and exposes manual GC. The server also runs GC every 24 hours; unreferenced blobs retain a seven-day grace period.
- `SIGTERM`/`SIGINT` stops new requests, drains in-flight work through Fastify close, clears maintenance timers, and then closes SQLite.

## Supported Agents

The built-in adapter set targets Claude Code, OpenAI Codex, OpenCode, Pi Coding Agent, Oh My Pi (OMP), and Grok Build.

## Architecture

- `apps/server` — Fastify API, SQLite metadata, encrypted blob storage, authentication, and release orchestration
- `apps/web` — React and Vite single-page administration UI; Terminal Brutalism design system (Space Grotesk + JetBrains Mono, `lucide-react` icons, `motion` spring animations); Lenis smooth scroll managed by `AppShell` `useEffect`, disabled under `prefers-reduced-motion`
- `packages/protocol` — shared Zod wire contracts
- `packages/adapters` — shared agent validation, rendering, and local path safety
- `packages/cli` — standalone pull-only npm CLI

Production serves the Web build from the server. All API routes are versioned under `/api/v1`.

## Security Model

The server is authoritative and clients are pull-only. Secrets are entered through structured credential forms, encrypted with per-record data keys, and frozen into exact release outputs. Tokens are stored server-side only as hashes. Release manifests contain logical targets rather than server or client absolute paths. The CLI limits writes and deletions to adapter-approved targets it can prove are managed.

## Release Status

The repository contains a verified pre-release implementation. Web production E2E, authentication/encryption integration, six-adapter contracts, real packaged `npx` pulls, crash recovery, Blob GC, and non-root Compose startup have executable coverage. The npm registry publication has not been performed; APIs may still change before the first tagged release.

## License

[MIT](LICENSE) © 2026 Lynricsy
