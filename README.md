---
links: "[[Ideaverse/AI/coogle/coogle|coogle]]"
---

# Coogle

Google Workspace MCP multiplexer for Claude Code. One persistent daemon holds the single `coogle-mcp` connection. Every Claude Code session goes through it. No more credential conflicts, no more 142 tools registering simultaneously.

---

## The problem it solves

Coogle is the MCP server that gives Claude access to Gmail, Calendar, Drive, Docs, Sheets, and the rest of Google Workspace — across multiple sessions simultaneously.

The naive setup — running Google Workspace MCP directly — works fine for one session. The moment you open a second Claude Code window, both sessions try to own the same Google OAuth credentials. They fight, one wins, the other gets errors or stale tokens.

Coogle solves this with a daemon pattern: one persistent process holds the Google Workspace connection and serializes all calls through a queue. Every Claude Code session runs a thin MCP shim that forwards tool calls to the daemon over a Unix Domain Socket. From Claude's perspective nothing changes — 142 tools are available. Under the hood, every call goes through a single, stable connection.

```
Claude Code (session 1)
Claude Code (session 2)  ──>  coogle daemon  ──>  coogle-mcp  ──>  Google APIs
Claude Code (session 3)
```

---

## Quick start

Tell Claude Code:

> Clone https://github.com/mnott/Coogle and set it up for me

Claude clones the repo, finds the setup skill, and handles everything autonomously — prerequisites, build, config, daemon install, and Google OAuth. You just approve the permissions in your browser when prompted.

### Alternative: install from GitHub Releases

If you prefer a traditional install without cloning:

```bash
npm i -g https://github.com/mnott/Coogle/releases/latest/download/coogle.tgz
coogle setup
```

Update: `pai update --package @tekmidian/coogle`. The npm registry is no longer updated; releases come from GitHub.

The wizard handles everything: environment check, credentials, config, daemon install, launchd service, and Claude config patching.

### Prerequisites

- Node.js >= 18
- `uvx` (from [uv](https://github.com/astral-sh/uv)): `brew install uv` or `pip install uv`
- Google OAuth credentials (Client ID + Client Secret from Google Cloud Console)

### Manual clone and build

```bash
git clone https://github.com/mnott/Coogle ~/dev/apps/coogle
cd ~/dev/apps/coogle
npm install
npm run build
node dist/index.js setup
```

The wizard walks you through eight steps:

1. **Environment check** — verifies Node and `uvx` are available
2. **Credentials** — finds Google OAuth Client ID and Secret from `~/.claude.json` (any MCP server entry with `GOOGLE_OAUTH_CLIENT_ID` in its `env` block) or prompts for them manually
3. **Config** — writes `~/.config/coogle/config.json`
4. **Build check** — confirms `dist/index.js` exists
5. **Daemon test** — starts a temporary daemon, verifies the IPC socket, counts available tools
6. **launchd service** — installs `com.pai.coogle` as a macOS launch agent (auto-starts on login)
7. **Claude config** — updates `~/.claude.json` to point the `coogle` MCP server at the coogle shim
8. **Summary** — shows what was done and how to roll back

After setup, restart Claude Code. The coogle shim starts automatically when Claude loads, discovers all tools from the daemon, and proxies every call.

---

## How it works

Coogle has two runtime components:

**Daemon** (`src/daemon.ts`) — a long-running process that spawns and owns a single `coogle-mcp` child via stdio. It listens on a Unix Domain Socket (`/tmp/coogle.sock`) and serializes all incoming tool calls through a queue. If the child crashes, it auto-respawns with a 3-second cooldown.

**MCP shim** (`src/mcp-server.ts`) — a thin proxy started by Claude Code. On startup it connects to the daemon socket, dynamically discovers all available tools, registers them with the MCP SDK, and forwards every `tools/call` request to the daemon over IPC.

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
  coogle-mcp backend
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
    "mcpServerName": "coogle"
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
| `mcp.args` | `["workspace-mcp", "--tool-tier", "core"]` | Arguments for the Google Workspace MCP backend |
| `credentials.source` | `claude-json` | Where to load Google OAuth credentials from |
| `credentials.claudeJsonPath` | `~/.claude.json` | Path to Claude config (for `claude-json` source) |
| `credentials.mcpServerName` | `coogle` | MCP server key to read credentials from |
| `callTimeoutMs` | `120000` | Per-call timeout in milliseconds |
| `logLevel` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `defaultAccount` | _(unset)_ | Google account used when a call omits `user_google_email` |
| `autoOpenAuth` | `false` | Allow the child to open a browser window when it wants authorization |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COOGLE_AUTO_OPEN_AUTH` | unset (off) | Set to `1` to let the `workspace-mcp` child open a browser window on an authorization prompt. Overrides `autoOpenAuth`. |

The daemon normally runs under launchd, so set this in `com.pai.coogle.plist`
(`EnvironmentVariables`) rather than in your shell, then restart the daemon.

---

## Multi-account (Google Workspace)

Coogle supports managing multiple Google accounts simultaneously. Each account needs a one-time OAuth authorization, after which all 142 tools work for any authorized account — just pass the appropriate `user_google_email` parameter.

### How it works

OAuth tokens are stored per user in `~/.google_workspace_mcp/credentials/`:

```
~/.google_workspace_mcp/credentials/
├── alice@example.com.json
├── bob@example.com.json
└── carol@example.com.json
```

The OAuth Client ID and Client Secret (app credentials) are shared across all accounts — they come from your Google Cloud project. Each user gets their own refresh token after completing the consent flow once.

### Adding a new account

1. **Ensure credentials are configured.** The daemon needs the OAuth Client ID and Client Secret. The recommended approach is `manual` source in `~/.config/coogle/config.json`:

```json
{
  "credentials": {
    "source": "manual",
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-your-client-secret"
  }
}
```

You can find these values in an existing token file at `~/.google_workspace_mcp/credentials/<email>.json` (fields `client_id` and `client_secret`) or in your Google Cloud Console.

2. **Restart the daemon** so it picks up the credentials:

```bash
# Kill the daemon (launchd auto-restarts it)
launchctl kickstart -k gui/$(id -u)/com.pai.coogle
```

3. **Trigger the OAuth flow** for the new account. From Claude Code, call:

```
start_google_auth(service_name="people", user_google_email="newuser@example.com")
```

Or call any tool with the new email — `workspace-mcp` will return an authorization URL if no token exists.

4. **Open the authorization URL** in a browser, sign in as the target account, and approve the permissions. The callback goes to `localhost:8000` (the OAuth server built into `workspace-mcp`).

   Coogle does not open the browser for you — a tool call must never pop a window
   while you are working. Take the URL from the daemon log:

   ```bash
   grep -A1 "Authorization URL for" /tmp/coogle.log | tail -2
   ```

   To have the browser open automatically instead, set `COOGLE_AUTO_OPEN_AUTH=1`
   for the daemon (see [Environment variables](#environment-variables)).

5. **Done.** A token file is saved to `~/.google_workspace_mcp/credentials/newuser@example.com.json`. All subsequent tool calls with that email work immediately.

### Google Workspace family/team domains

If all accounts are on the same Google Workspace domain (e.g. `@example.com`) and you are the domain admin, you can authorize all accounts yourself — just sign in as each user in the browser when the consent screen appears. No need for each person to do it themselves.

### Important notes

- **Calendar sharing vs. Contacts:** Google Calendar supports delegation — you can access shared calendars with just one account's token. Google Contacts has no sharing model. Each account must be individually authorized to manage its contacts.
- **Token refresh:** Coogle refreshes each account's access token itself, 10 minutes before it expires, and writes it to the file the child reads. This is deliberate — see [Authorization prompts](#authorization-prompts-and-token-refresh) below.
- **Refresh token lifetime:** Refresh tokens are long-lived only once the OAuth consent screen is **published to production**. While the consent screen is in `Testing` mode, Google expires every refresh token after 7 days, and each account then needs a fresh authorization. If accounts keep needing re-authorization about weekly, publish the consent screen in Google Cloud Console → APIs & Services → OAuth consent screen.
- **Alias addresses:** If an account is authorized under an alias (say `gina@example.de` for the account `gina@example.org`), the credential file is named after the alias while Google's ID token names the canonical account. `workspace-mcp` binds one account per stdio session and rejects the mismatch as a session rebind. Coogle logs a `NOTE:` line when it detects this; no action is needed, because keeping the token fresh avoids the child's refresh path entirely.
- **Port 8000:** The `workspace-mcp` OAuth callback server listens on `localhost:8000`. If this port is occupied when you trigger an auth flow, restart the daemon first.

---

## Manual Claude Code configuration

If you prefer not to use the setup wizard, edit `~/.claude.json` directly. Find the `coogle` entry under `mcpServers` and replace its `command`/`args` with the coogle shim:

```json
{
  "mcpServers": {
    "coogle": {
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

`coogle-mcp` started but returned no tools. This usually means the Google OAuth token has expired or is missing.

`workspace-mcp` manages its own OAuth tokens independently — they are stored in `~/.google_workspace_mcp/credentials/`. To re-authenticate, delete the cached token file and restart the daemon:

```bash
rm -r ~/.google_workspace_mcp/credentials/
node dist/index.js restart
```

`workspace-mcp` will prompt for a new OAuth flow on the next call.

Note: re-running `node dist/index.js setup` will **not** fix expired tokens. The setup wizard only handles the OAuth Client ID and Client Secret (app credentials). Token lifecycle is managed entirely by `workspace-mcp`.

### Authorization prompts and token refresh

**"ACTION REQUIRED: Google Authentication Needed" — but nothing was revoked**

Symptom: the first call for an account after an idle period fails with an
authorization demand, a Google consent page opens by itself, and repeating the
identical call immediately succeeds without doing anything.

Cause: `workspace-mcp` escalates to a full re-authorization whenever *its own*
token refresh fails, and one such failure is structural for a multi-account
daemon. The child binds a single Google account to its one stdio session. When
it refreshes an account whose credential file is named after an alias, the ID
token in the refresh response names the canonical account, the child treats that
as a session rebind and rejects it — discarding credentials it had just
refreshed successfully. It then opens a browser as a side effect of the failed
tool call. The retry works because the refreshed token is already on disk, so no
refresh is attempted the second time.

Coogle handles this in three layers:

1. **Refresh ahead.** Before forwarding a call, coogle refreshes that account's
   access token if it expires within 10 minutes, writing it to the file the child
   reads. The child then loads a valid token and never enters its refresh path.
2. **Refresh and retry.** If an authorization demand still comes back, coogle
   forces a refresh and retries the call once. The child raises the demand before
   it builds any Google service client, so no API work is repeated. A successful
   retry is invisible to the caller.
3. **Short message.** If authorization is genuinely required, coogle replaces the
   child's multi-paragraph prompt (which inlines all ~40 OAuth scopes) with a few
   lines naming the account and the reason, and writes the authorization URL to
   the daemon log.

No browser is opened at any point unless `COOGLE_AUTO_OPEN_AUTH=1` is set.

Note: the child's own log line `Opened auth URL in browser automatically` is
inaccurate when auto-open is disabled. Coogle points the child's `$BROWSER` at a
no-op binary, so the call succeeds without launching anything.

**Daemon keeps crashing**

Check `/tmp/coogle.log` for error messages. The daemon has a 3-second respawn cooldown — launchd will restart it automatically but the `ThrottleInterval` in the plist prevents tight restart loops.

**Multiple Claude sessions getting stale results**

This is the condition coogle was built to prevent. Verify all sessions are using the coogle shim:

```bash
node dist/index.js status
```

Check that `~/.claude.json` shows `node .../coogle/dist/index.js mcp` as the coogle MCP command.

**Rollback to pre-coogle configuration**

```bash
cp ~/.claude.json.backup ~/.claude.json
```

Restart Claude Code to apply.

---

## Security

- Google OAuth app credentials (Client ID and Client Secret) are read from `~/.claude.json` or `~/.config/coogle/config.json`. OAuth tokens obtained after authentication are managed by `workspace-mcp` and stored in `~/.google_workspace_mcp/credentials/`. All files are local and not transmitted anywhere by Coogle.
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

---
*Links:* [[Ideaverse/AI/coogle/coogle|coogle]]
