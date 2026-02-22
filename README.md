# Coogle

Google Workspace MCP multiplexer for Claude Code. One persistent daemon holds the single `coogle-mcp` connection. Every Claude Code session goes through it. No more credential conflicts, no more 142 tools registering simultaneously.

---

## The problem it solves

Coogle is the MCP server that gives Claude access to Gmail, Calendar, Drive, Docs, Sheets, and the rest of Google Workspace — across multiple sessions simultaneously.

The naive setup — pointing Claude directly at `uvx workspace-mcp` — works fine for one session. The moment you open a second Claude Code window, both sessions try to own the same Google OAuth credentials. They fight, one wins, the other gets errors or stale tokens.

Coogle solves this with a daemon pattern: one persistent process holds the Google Workspace connection and serializes all calls through a queue. Every Claude Code session runs a thin MCP shim that forwards tool calls to the daemon over a Unix Domain Socket. From Claude's perspective nothing changes — 142 tools are available. Under the hood, every call goes through a single, stable connection.

```
Claude Code (session 1)
Claude Code (session 2)  ──>  coogle daemon  ──>  workspace-mcp  ──>  Google APIs
Claude Code (session 3)
```

---

## Quick start

### Prerequisites

- Node.js >= 18
- `uvx` (from [uv](https://github.com/astral-sh/uv)): `brew install uv` or `pip install uv`
- Google OAuth credentials (Client ID + Client Secret from Google Cloud Console)

### Install and set up

The fastest path — run the interactive setup wizard directly with npx:

```bash
npx -y @tekmidian/coogle setup
```

That's it. The wizard handles everything: environment check, credentials, config, daemon install, launchd service, and Claude config patching.

**Prefer to clone and build locally?**

```bash
git clone https://github.com/mnott/Coogle ~/dev/apps/coogle
cd ~/dev/apps/coogle
npm install
npm run build
node dist/index.js setup
```

The wizard walks you through eight steps:

1. **Environment check** — verifies Node and `uvx` are available
2. **Credentials** — finds Google OAuth credentials in `~/.claude.json` or prompts for them manually
3. **Config** — writes `~/.config/coogle/config.json`
4. **Build check** — confirms `dist/index.js` exists
5. **Daemon test** — starts a temporary daemon, verifies the IPC socket, counts available tools
6. **launchd service** — installs `com.pai.coogle` as a macOS launch agent (auto-starts on login)
7. **Claude config** — updates `~/.claude.json` to point the `workspace` MCP server at the coogle shim
8. **Summary** — shows what was done and how to roll back

After setup, restart Claude Code. The coogle shim starts automatically when Claude loads, discovers all tools from the daemon, and proxies every call.

---

## How it works

Coogle has two runtime components:

**Daemon** (`src/daemon.ts`) — a long-running process that spawns and owns a single `coogle-mcp` child via stdio. It listens on a Unix Domain Socket (`/tmp/coogle.sock`) and serializes all incoming tool calls through a queue. If the child crashes, it auto-respawns with a 3-second cooldown.

**MCP shim** (`src/mcp-server.ts`) — a thin proxy started by Claude Code in place of `uvx workspace-mcp`. On startup it connects to the daemon socket, dynamically discovers all available tools, registers them with the MCP SDK, and forwards every `tools/call` request to the daemon over IPC.

```
Claude Code (MCP stdio)
       |
       |  JSON-RPC (stdio)
       |
  MCP shim (coogle mcp)
       |
       |  NDJSON (Unix socket /tmp/coogle.sock)
       |
  Coogle daemon (coogle serve)
       |
       |  MCP stdio
       |
  workspace-mcp (uvx workspace-mcp --tool-tier core)
       |
       |  HTTPS
       |
  Google APIs
```

---

## CLI commands

```bash
# Start the daemon (normally managed by launchd)
node dist/index.js serve

# Start the MCP shim (used as the Claude MCP command)
node dist/index.js mcp

# Check daemon status
node dist/index.js status

# Restart the coogle-mcp child process
node dist/index.js restart

# Print the resolved configuration
node dist/index.js config

# Generate the launchd plist for this system (outputs to stdout)
node dist/index.js generate-plist

# Interactive first-time setup
node dist/index.js setup
```

---

## Configuration

Config lives at `~/.config/coogle/config.json`. It is created automatically by `setup` or on first `serve`.

```json
{
  "socketPath": "/tmp/coogle.sock",
  "mcp": {
    "command": "uvx",
    "args": ["workspace-mcp", "--tool-tier", "core"]
  },
  "credentials": {
    "source": "claude-json",
    "claudeJsonPath": "~/.claude.json",
    "mcpServerName": "workspace"
  },
  "callTimeoutMs": 120000,
  "logLevel": "info"
}
```

### Credential sources

| `source` | How credentials are loaded |
|----------|---------------------------|
| `claude-json` (default) | Read `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from the named MCP server's `env` block in `~/.claude.json` |
| `env` | Read from `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` environment variables |
| `manual` | Stored directly in config as `clientId` and `clientSecret` |

### All config fields

| Field | Default | Description |
|-------|---------|-------------|
| `socketPath` | `/tmp/coogle.sock` | Unix Domain Socket path for IPC |
| `mcp.command` | `uvx` | Command to run coogle-mcp |
| `mcp.args` | `["workspace-mcp", "--tool-tier", "core"]` | Arguments for coogle-mcp |
| `credentials.source` | `claude-json` | Where to load Google OAuth credentials from |
| `credentials.claudeJsonPath` | `~/.claude.json` | Path to Claude config (for `claude-json` source) |
| `credentials.mcpServerName` | `workspace` | MCP server key to read credentials from |
| `callTimeoutMs` | `120000` | Per-call timeout in milliseconds |
| `logLevel` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

---

## Manual Claude Code configuration

If you prefer not to use the setup wizard, edit `~/.claude.json` directly. Find the `workspace` entry under `mcpServers` and replace its `command`/`args` with the coogle shim:

```json
{
  "mcpServers": {
    "workspace": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/coogle/dist/index.js", "mcp"]
    }
  }
}
```

The `env` block with `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` is no longer needed in the Claude config — the daemon reads credentials directly and injects them into the `coogle-mcp` child environment.

Keep a backup of the original config before editing:

```bash
cp ~/.claude.json ~/.claude.json.backup
```

The setup wizard creates this backup automatically.

---

## launchd service

The daemon is designed to run as a persistent macOS launch agent. The setup wizard installs it automatically. To manage it manually:

```bash
# Generate the plist (uses the correct node and index.js paths for your system)
node dist/index.js generate-plist > ~/Library/LaunchAgents/com.pai.coogle.plist

# Load (start)
launchctl load ~/Library/LaunchAgents/com.pai.coogle.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.pai.coogle.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.pai.coogle
```

Logs go to `/tmp/coogle.log`.

```bash
tail -f /tmp/coogle.log
```

---

## Google Workspace tools

The 142 available tools span 12 Google services. They are discovered dynamically from `coogle-mcp` on daemon startup — no hardcoded list.

| Service | Example tools |
|---------|--------------|
| Gmail | `search_gmail_messages`, `send_gmail_message`, `get_gmail_thread_content` |
| Calendar | `get_events`, `create_event`, `modify_event`, `query_freebusy` |
| Drive | `search_drive_files`, `list_drive_items`, `share_drive_file`, `copy_drive_file` |
| Docs | `get_doc_content`, `modify_doc_text`, `create_doc`, `insert_doc_elements` |
| Sheets | `read_sheet_values`, `modify_sheet_values`, `create_spreadsheet` |
| Slides | `create_presentation`, `get_presentation`, `batch_update_presentation` |
| Forms | `create_form`, `get_form`, `list_form_responses` |
| Contacts | `search_contacts`, `create_contact`, `list_contact_groups` |
| Chat | `send_message`, `get_messages`, `list_spaces` |
| Tasks | `list_tasks`, `create_task`, `update_task`, `move_task` |
| Scripts | `run_script_function`, `create_script_project` |
| Search | `search_custom`, `get_search_engine_info` |

---

## Troubleshooting

**"Coogle daemon not running"**

The shim cannot reach the daemon socket. Start the daemon:

```bash
node dist/index.js serve
```

Or check if the launchd service is loaded:

```bash
launchctl list | grep coogle
cat /tmp/coogle.log
```

**"coogle-mcp child is not connected"**

The daemon is running but `coogle-mcp` failed to start or crashed. Check the log:

```bash
tail -50 /tmp/coogle.log
```

Common cause: `uvx` not in PATH, or Google OAuth credentials are missing/expired. Try restarting the child:

```bash
node dist/index.js restart
```

**No tools discovered / tool count is 0**

`coogle-mcp` started but returned no tools. This usually means authentication has expired. Re-run the setup:

```bash
node dist/index.js setup
```

Or trigger a fresh Google OAuth flow via `coogle-mcp` directly:

```bash
uvx workspace-mcp --tool-tier core
```

**Daemon keeps crashing**

Check `/tmp/coogle.log` for error messages. The daemon has a 3-second respawn cooldown — launchd will restart it automatically but the `ThrottleInterval` in the plist prevents tight restart loops.

**Multiple Claude sessions getting stale results**

This is the condition coogle was built to prevent. Verify all sessions are using the shim (not `uvx workspace-mcp` directly, which bypasses coogle):

```bash
node dist/index.js status
```

Check that `~/.claude.json` shows `node .../coogle/dist/index.js mcp` as the workspace command, not `uvx workspace-mcp` (the direct connection that bypasses coogle).

**Rollback to direct uvx workspace-mcp**

```bash
cp ~/.claude.json.backup ~/.claude.json
```

Restart Claude Code to apply.

---

## Security

- Google OAuth credentials are read from `~/.claude.json` or `~/.config/coogle/config.json`. Both files are local and not transmitted anywhere.
- The daemon communicates with `coogle-mcp` over stdio (same machine, same user).
- The IPC socket at `/tmp/coogle.sock` is local only and accessible only to the current user.
- No credentials are ever sent over the network by coogle itself — all OAuth flows are handled by `coogle-mcp`.

---

## Requirements

- Node.js >= 18
- `uvx` (from [uv](https://docs.astral.sh/uv/)) for running `coogle-mcp`
- Google Cloud project with OAuth 2.0 credentials (Client ID + Client Secret)
- macOS for launchd auto-start (Linux works for manual daemon operation)

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run the daemon directly
npm start

# Run the MCP shim directly
npm run mcp
```

---

## License

MIT — see [LICENSE](LICENSE)

## Author

Matthias Nott — [github.com/mnott](https://github.com/mnott)
