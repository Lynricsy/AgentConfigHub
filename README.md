# AgentConfigHub

[简体中文](README.zh-CN.md)

> A self-hosted control plane for securely editing, versioning, and distributing configuration across AI coding agents.

## Overview

AgentConfigHub is a personal, single-instance configuration control plane. Its server is the only source of truth: administrators edit named configuration sets in a password-protected Web UI, publish immutable releases, and approved devices pull those releases with a standalone CLI. Clients never upload local agent configuration.

## Why AgentConfigHub

AI coding agents use different files, roots, formats, and authentication conventions. Copying configuration by hand makes drift, accidental secret exposure, and destructive overwrites likely. AgentConfigHub provides one explicit release boundary while retaining each agent's native file format.

## Features

AgentConfigHub is under active development. The target release includes:

- Named, independent configuration sets and immutable releases with rollback
- Encrypted blobs and credential revisions backed by envelope encryption
- Password-protected administration and one-time device pairing approval
- Transactional, cross-platform installation with backups and managed-file safety
- Native file editing, shared instructions, and portable Agent Skills
- A pull-only CLI designed to run as `npx agent-config-hub`

Commands and deployment instructions will be added after their end-to-end paths are verified.

## Supported Agents

The built-in adapter set targets Claude Code, OpenAI Codex, OpenCode, Pi Coding Agent, Oh My Pi (OMP), and Grok Build.

## Architecture

- `apps/server` — Fastify API, SQLite metadata, encrypted blob storage, authentication, and release orchestration
- `apps/web` — React and Vite single-page administration UI
- `packages/protocol` — shared Zod wire contracts
- `packages/adapters` — shared agent validation, rendering, and local path safety
- `packages/cli` — standalone pull-only npm CLI

Production serves the Web build from the server. All API routes are versioned under `/api/v1`.

## Security Model

The server is authoritative and clients are pull-only. Secrets are entered through structured credential forms, encrypted with per-record data keys, and frozen into exact release outputs. Tokens are stored server-side only as hashes. Release manifests contain logical targets rather than server or client absolute paths. The CLI limits writes and deletions to adapter-approved targets it can prove are managed.

## Development Status

The repository is being built from an approved implementation plan. Public APIs, npm installation, container deployment, and operational commands are not considered released until the corresponding automated and end-to-end verification succeeds.

## License

[MIT](LICENSE) © 2026 Lynricsy
