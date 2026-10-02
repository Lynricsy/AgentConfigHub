# AgentConfigHub CLI

Pull immutable releases from a self-hosted AgentConfigHub server and install them transactionally into native coding-agent configuration directories.

## Requirements

- Node.js 24 or newer
- An AgentConfigHub server
- A browser-approved device token or a pull-only automation token

## Login

```bash
npx --yes agent-config-hub@latest login \
  --server https://agent-config-hub.example.com \
  --name "$(hostname)"
```

Open the verification URL printed by the CLI and approve the displayed user code in the server's **Devices** page.

## Pull a release

List available configuration groups:

```bash
npx --yes agent-config-hub@latest config-sets
```

Preview changes before writing files:

```bash
npx --yes agent-config-hub@latest pull \
  --profile main \
  --agent omp \
  --dry-run
```

Install the latest immutable release:

```bash
npx --yes agent-config-hub@latest pull \
  --profile main \
  --agent omp
```

The adapter supplies each Agent's default destination. Override a root for one invocation when needed:

```bash
npx --yes agent-config-hub@latest pull \
  --profile main \
  --agent omp \
  --target-root "omp-home=$HOME/.omp/agent"
```

Inspect the installed state:

```bash
npx --yes agent-config-hub@latest status --profile main
```

## OMP plugins and skill repositories

When the release contains `omp-home/agent-config-hub.json`, every pull (after the files are installed) runs `omp plugin install <spec>` for each declared plugin and clones or fast-forwards each declared `https://` skill repository into `<omp-home>/skill-repositories/<name>`. `--dry-run` only prints the plan. Updates are strict fast-forwards: clones with uncommitted changes, local commits, rewritten upstream history, or a different `origin` are never overwritten; the command exits non-zero instead. `omp` and `git` must be on `PATH`.

The Magic Context user config is managed under the `cortexkit-home` root (default `~/.config/cortexkit`); with `XDG_CONFIG_HOME` set, run `agent-config-hub roots set cortexkit-home "$XDG_CONFIG_HOME/cortexkit"` once.

## Automation

Keep pull tokens out of command arguments:

```bash
export AGENT_CONFIG_HUB_SERVER='https://agent-config-hub.example.com'
export AGENT_CONFIG_HUB_TOKEN='agch_auto_...'
npx --yes agent-config-hub@latest pull --profile main --agent omp
```

## Safety model

The CLI validates the immutable manifest, streams and hashes downloads, stages replacements on the destination filesystem, backs up overwritten and deleted managed files, rejects unsafe links, and commits through a crash-recoverable journal. It refuses to delete locally modified managed files unless `--force-remove-modified` is explicitly supplied.

Commands:

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

Output is styled (colors, tables, spinners) only when stdout is a terminal and follows `NO_COLOR` / `FORCE_COLOR`. Piped or redirected output stays plain text, tab-separated for list commands; spinners write to stderr only.

Server deployment and architecture documentation: [AgentConfigHub](https://github.com/Lynricsy/AgentConfigHub).
