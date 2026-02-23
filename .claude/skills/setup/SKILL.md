---
name: setup-coogle
description: Install and configure the Coogle Google Workspace MCP daemon. USE WHEN user says "set up coogle" OR "install coogle" OR "configure google workspace mcp" OR "coogle setup" OR user has just cloned the repo and asks Claude to install it.
---

# Coogle Setup Skill

You are performing a complete, autonomous first-time installation of Coogle — a persistent daemon that multiplexes Google Workspace MCP calls across multiple Claude Code sessions. Work through all steps without asking the user for input except at the two points explicitly marked USER INPUT REQUIRED.

The repo is at the current working directory. Resolve its absolute path once and use it throughout.

---

## Step 1 — Check prerequisites

Run these checks in parallel:

```bash
node --version
which uvx || uvx --version 2>/dev/null || echo "NOT FOUND"
```

**Node.js:** Must be >= 18. If the version is older, stop and tell the user: "Node.js 18 or later is required. Install it from https://nodejs.org or via your package manager."

**uvx:** Must be present in PATH. If missing, tell the user:

> uvx (from uv) is required to run workspace-mcp. Install it with:
>   brew install uv
> or:
>   pip install uv
> Then re-run setup.

If both prerequisites pass, continue.

---

## Step 2 — Install dependencies and build

Run sequentially:

```bash
npm install
npm run build
```

Verify `dist/index.js` exists after the build. If the build fails, show the error output and stop.

---

## Step 3 — Resolve OAuth credentials

**Do not ask the user yet.** First check these locations silently and use the first one that yields valid credentials:

1. `~/.config/coogle/config.json` — if it exists and has `credentials.source === "manual"` with non-empty `clientId` and `clientSecret`, extract those values.

2. `~/.claude.json` — scan every entry under `mcpServers`. If any entry has an `env` block containing `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, extract those values. Note the server name.

3. `~/.claude.json.backup` — same scan as above.

4. `~/.google_workspace_mcp/credentials/` — if this directory exists and contains any `*.json` files, read one. These token files contain `client_id` and `client_secret` at the top level. Extract those values.

If credentials are found via any of the above, tell the user: "Found existing Google OAuth credentials — using those." and proceed to Step 4 without prompting.

**USER INPUT REQUIRED — only if no credentials were found:**

Tell the user:

> No existing Google OAuth credentials found. I need your Google OAuth Client ID and Client Secret.
>
> To get them:
> 1. Go to https://console.cloud.google.com/
> 2. Select (or create) a project
> 3. Navigate to APIs & Services > Credentials
> 4. Under "OAuth 2.0 Client IDs", find or create a credential of type "Desktop app"
> 5. Copy the Client ID (ends in .apps.googleusercontent.com) and Client Secret (starts with GOCSPX-)
>
> Please provide:
> - Google OAuth Client ID:
> - Google OAuth Client Secret:

Wait for the user's response before continuing.

---

## Step 4 — Write config

Determine the absolute path to `dist/index.js` in the repo. Resolve the absolute path to `uvx` using `which uvx`.

Write `~/.config/coogle/config.json` with this content (create the directory if it does not exist):

```json
{
  "socketPath": "/tmp/coogle.sock",
  "mcp": {
    "command": "<absolute-path-to-uvx>",
    "args": ["workspace-mcp", "--tool-tier", "core"]
  },
  "credentials": {
    "source": "manual",
    "clientId": "<client-id>",
    "clientSecret": "<client-secret>"
  },
  "callTimeoutMs": 120000,
  "logLevel": "info"
}
```

Replace `<absolute-path-to-uvx>` with the actual path from `which uvx`, and fill in the credentials.

If credentials came from `~/.claude.json` (source 2 or 3 above), you may alternatively use `source: "claude-json"` pointing to that file and server name — but `source: "manual"` is always safe and preferred when the credentials are already in hand.

Verify the file was written successfully by reading it back.

---

## Step 5 — Configure Claude Code

Check whether `~/.claude.json` exists and is valid JSON.

If `~/.claude.json` does not exist, tell the user: "~/.claude.json not found. You will need to add the coogle MCP entry manually after Claude Code creates it." Then skip to Step 6.

If it exists:

1. Back it up first: `cp ~/.claude.json ~/.claude.json.backup` — but only if a backup doesn't already exist that contains `GOOGLE_OAUTH_CLIENT_ID` in its mcpServers (that backup is the original and should be preserved).

2. Find the server key to update using this priority order:
   - A key named `coogle`
   - A key named `workspace` (legacy — rename it to `coogle`)
   - Any key whose `env` block contains `GOOGLE_OAUTH_CLIENT_ID`
   - If none found, create a new key named `coogle`

3. Replace (or create) that entry with:
   ```json
   {
     "type": "stdio",
     "command": "node",
     "args": ["<absolute-path-to-dist/index.js>", "mcp"]
   }
   ```
   The `env` block with OAuth credentials is NOT needed here — the daemon reads credentials from config directly.

4. Write the updated `~/.claude.json` back.

Tell the user: "Updated ~/.claude.json. Claude Code must be restarted for the change to take effect."

---

## Step 6 — Install launchd service (macOS only)

Check if the platform is macOS: `uname -s` should return `Darwin`.

If not macOS, skip this step and note: "launchd auto-start is macOS only. Start the daemon manually with: `node <path>/dist/index.js serve`"

If macOS:

1. Generate the plist:
   ```bash
   node dist/index.js generate-plist > ~/Library/LaunchAgents/com.pai.coogle.plist
   ```

2. If an existing plist is already loaded, unload it first:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.pai.coogle.plist 2>/dev/null || true
   ```

3. Load the new plist:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.pai.coogle.plist
   ```

4. Wait up to 10 seconds for the socket to appear at `/tmp/coogle.sock`. Poll with:
   ```bash
   ls /tmp/coogle.sock 2>/dev/null && echo "ready" || echo "not yet"
   ```

5. Once the socket appears, check daemon status:
   ```bash
   node dist/index.js status
   ```

   Expected output shows `Child connected: true` and a tool count greater than 0. If `Child connected: false`, wait 3 more seconds and retry once — workspace-mcp may still be initializing.

If the socket never appears after 10 seconds, check the log:
```bash
tail -20 /tmp/coogle.log
```
Report the last lines to the user and note common causes: uvx not found, credentials missing or wrong, port 8000 already in use.

---

## Step 7 — Trigger initial Google OAuth

The daemon is now running but has no user token yet. Trigger the OAuth flow for the user's primary Google account.

**USER INPUT REQUIRED — ask the user:**

> What is your primary Google email address for Workspace access?
> (e.g. you@gmail.com or you@yourdomain.com)

Wait for their answer, then call:

```
mcp__coogle__start_google_auth with service_name="people", user_google_email="<email>"
```

If the tool returns an authorization URL, tell the user:

> Open this URL in your browser and sign in with your Google account:
>
> <URL>
>
> After you approve the permissions, you'll be redirected to localhost:8000 and the token will be saved automatically. Let me know when done.

Wait for the user to confirm the browser flow is complete before continuing.

If the tool returns successfully without a URL, the token already exists — continue.

---

## Step 8 — Verify end-to-end

Run a lightweight verification call using the user's email:

```
mcp__coogle__list_calendars with user_google_email="<email>"
```

If this returns a list of calendars (even empty), the setup is complete and working.

If it fails, check `/tmp/coogle.log` for errors and report them. Common resolutions:
- "no token found" — the OAuth flow in Step 7 may not have completed; repeat it
- "uvx not found" — verify uvx is in PATH and that the plist EnvironmentVariables PATH includes its directory; update the plist and reload
- "connection refused" — daemon crashed; run `tail -30 /tmp/coogle.log` and report

---

## Step 9 — Summary

Report the following to the user:

- Coogle daemon status (running/not running)
- Number of tools available (from `node dist/index.js status`)
- Location of config: `~/.config/coogle/config.json`
- Location of logs: `/tmp/coogle.log`
- Whether launchd is installed (auto-starts on login)
- Whether `~/.claude.json` was updated (restart required)

Provide these management commands:

```bash
# Check status
node <path>/dist/index.js status

# Restart the workspace-mcp child (useful if tools become unavailable)
node <path>/dist/index.js restart

# View logs
tail -f /tmp/coogle.log

# Stop launchd service
launchctl unload ~/Library/LaunchAgents/com.pai.coogle.plist

# Rollback Claude config
cp ~/.claude.json.backup ~/.claude.json
```

---

## Multi-account (optional)

If the user wants to add additional Google accounts, explain:

Each Google account needs a one-time OAuth flow. The app credentials (Client ID + Client Secret) are shared. For each additional account, call:

```
mcp__coogle__start_google_auth with service_name="people", user_google_email="other@example.com"
```

Open the returned URL, sign in as that account, and approve. The token is saved to `~/.google_workspace_mcp/credentials/other@example.com.json`. All 142 tools then work for that account by passing `user_google_email="other@example.com"` as a parameter.

Note: Google Calendar supports delegation (shared calendars with one token). Google Contacts does not — each account must be individually authorized.

---

## Troubleshooting reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Child connected: false` | workspace-mcp crashed | `node dist/index.js restart`; check `/tmp/coogle.log` |
| Tool count is 0 | Expired or missing token | Delete `~/.google_workspace_mcp/credentials/<email>.json`; re-run OAuth |
| Socket never appears | uvx not in plist PATH | Add uvx's directory to PATH in plist; `launchctl unload` + regenerate + reload |
| Port 8000 in use | Another process using OAuth callback port | Kill it or restart daemon to retry |
| Claude can't connect | `~/.claude.json` not updated or Claude not restarted | Verify mcpServers entry points to `node .../dist/index.js mcp`; restart Claude Code |

The setup wizard built into the repo (`node dist/index.js setup`) covers these same steps interactively and can be used as an alternative to this skill.
