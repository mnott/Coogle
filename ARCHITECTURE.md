# Coogle Architecture

Technical reference for contributors and developers.

---

## Overview

Coogle solves a concurrency problem: multiple Claude Code sessions cannot safely share a single `coogle-mcp` process. Coogle introduces a daemon that owns the sole `coogle-mcp` connection and serializes all calls. Each Claude Code session runs a thin MCP shim that proxies tool calls to the daemon over a Unix Domain Socket.

Two runtime components:

- **Daemon** (`src/daemon.ts`) — owns the `coogle-mcp` child process, serves IPC, serializes calls through a queue
- **MCP shim** (`src/mcp-server.ts`) — thin proxy started by Claude Code; no direct `coogle-mcp` connection

Supporting modules:

- `src/ipc-client.ts` — client-side IPC transport (used by both the shim and the CLI)
- `src/config.ts` — configuration loader and defaults
- `src/setup.ts` — interactive setup wizard
- `src/index.ts` — CLI entry point and plist generator

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code session 1                                           │
│   ~/.claude.json → mcpServers.coogle:                        │
│   "node /path/to/coogle/dist/index.js mcp"                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MCP stdio JSON-RPC
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ MCP shim  (mcp-server.ts)                                       │
│                                                                 │
│  startup:                                                       │
│    CoogleClient.listTools()  →  daemon.list_tools               │
│    register tools/list handler  (returns discovered tools)      │
│    register tools/call handler  (proxies all calls via IPC)     │
│                                                                 │
│  tools/call handler:                                            │
│    CoogleClient.call(name, args)  →  NDJSON over IPC socket     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code session 2    │                                      │
│   (same shim pattern)    │                                      │
└──────────────────────────┤                                      │
                           │ Unix Domain Socket                   │
                           │ /tmp/coogle.sock (NDJSON)            │
                           │ per-call: connect → send → recv → close
┌──────────────────────────┴──────────────────────────────────────┐
│ Coogle daemon  (daemon.ts)                           KeepAlive  │
│   managed by: launchd (com.pai.coogle)                          │
│                                                                 │
│  IPC server (Unix socket)                                       │
│    method == "list_tools"   →  mcpClient.listTools()            │
│    method == "status"       →  { connected, queueLength, ... }  │
│    method == "restart_child"→  spawnChild()                     │
│    method == *              →  enqueueCall(method, params)      │
│                                                                 │
│  Call queue (serializer)                                        │
│    callQueue: QueuedCall[]                                      │
│    drainQueue() — single mutex, processes one call at a time    │
│    auto-respawn on disconnect (3s cooldown)                     │
│    per-call timeout: 120s (configurable)                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MCP stdio (StdioClientTransport)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ coogle-mcp child process                                        │
│   command: uvx coogle-mcp --tool-tier core                      │
│   env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET       │
│        (injected from credentials source at startup)            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS / OAuth2
                           ▼
                    Google APIs
```

---

## IPC protocol

The daemon and all shim instances communicate over a Unix Domain Socket at `/tmp/coogle.sock` (configurable) using NDJSON — newline-delimited JSON. Each call is a single request-response exchange over a fresh connection. This stateless pattern keeps the client simple and eliminates connection lifecycle management.

### Request format

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "mcp__coogle__search_gmail_messages",
  "params": {
    "query": "from:alice subject:invoice",
    "maxResults": 10
  }
}
```

- `id` — UUID generated per call (via `crypto.randomUUID()`), echoed in the response for correlation
- `method` — tool name (forwarded to `coogle-mcp`) or a special daemon method
- `params` — tool-specific parameters, passed through unchanged

### Response format

Success:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": true,
  "result": { "content": [{ "type": "text", "text": "..." }] }
}
```

Error:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": false,
  "error": "Tool call timed out after 120s"
}
```

### Special IPC methods

These are handled directly by the daemon and never forwarded to `coogle-mcp`:

| Method | Description |
|--------|-------------|
| `list_tools` | Returns all tools available from the `coogle-mcp` child |
| `status` | Returns `{ connected, queueLength, uptime, childRunning }` |
| `restart_child` | Kills and respawns the `coogle-mcp` child |

All other methods are forwarded as `coogle-mcp` tool calls.

---

## Call queue and serialization

`coogle-mcp` is a single-threaded stdio process. Concurrent calls would interleave on its stdin and produce garbled output. The daemon serializes all calls through a queue with a mutex pattern.

```typescript
interface QueuedCall {
  method: string;
  params: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const callQueue: QueuedCall[] = [];
let processingPromise: Promise<void> | null = null;
```

`enqueueAndProcess()` pushes a call onto the queue and starts `drainQueue()` if no drain loop is running. The drain loop processes one call at a time:

```
enqueueCall(method, params)
  │
  └── enqueueAndProcess({ method, params, resolve, reject })
        │
        ├── push to callQueue
        └── if !processingPromise:
              processingPromise = drainQueue()
                │
                └── while callQueue.length > 0:
                      check connected → auto-respawn if needed
                      shift() one item
                      Promise.race([mcpClient.callTool(...), timeout])
                      resolve or reject the item
                    processingPromise = null
```

The mutex (`processingPromise`) ensures only one `drainQueue` loop runs at a time. Multiple IPC connections arriving simultaneously will all enqueue their calls, but execution is strictly sequential.

---

## coogle-mcp child lifecycle

The child is spawned using `@modelcontextprotocol/sdk`'s `StdioClientTransport`:

```
spawnChild()
  │
  ├── close existing mcpClient if any
  ├── loadCredentials()  →  build childEnv
  ├── resolveMcpCommand("uvx")  →  full path lookup in PATH
  ├── new StdioClientTransport({ command, args, env: childEnv })
  ├── new Client({ name: "coogle", version: "0.1.0" })
  ├── client.connect(transport)
  │     ├── success: isConnected = true
  │     └── transport.onclose → isConnected = false, drainQueueWithError()
  └── on error: isConnected = false, throw
```

**Auto-respawn:** When `drainQueue` finds `isConnected === false`, it attempts `spawnChild()` before processing the next item. A 3-second cooldown (`RESPAWN_COOLDOWN_MS`) prevents tight restart loops if the child consistently fails.

**Startup tolerance:** If `spawnChild()` fails at daemon startup, the daemon continues running and logs a warning. The first IPC call will trigger a respawn attempt.

---

## MCP shim startup sequence

```
runMcpServer(config)
  │
  ├── new CoogleClient(config.socketPath)
  ├── listToolsWithRetry(client)  — 3 attempts, 1s delay each
  │     └── client.listTools()  →  IPC "list_tools"
  ├── build toolMap: Map<name, ToolDefinition>
  ├── new Server({ name: "coogle", version: "0.1.0" })
  ├── server.setRequestHandler(ListToolsRequestSchema, ...)
  │     └── returns tools array directly from coogle-mcp
  ├── server.setRequestHandler(CallToolRequestSchema, ...)
  │     └── daemonClient.call(name, args)  →  IPC call
  └── server.connect(new StdioServerTransport())
```

The shim uses the low-level `Server` class (not `McpServer`) to pass `inputSchema` objects from `coogle-mcp` through unchanged. Using the higher-level `McpServer` would require schema conversion that could lose information.

**stdout discipline:** The MCP JSON-RPC transport uses stdout. Any non-JSON bytes on stdout break the protocol. All debug output in `mcp-server.ts` goes to `process.stderr`. This rule applies to all code paths reachable during shim operation.

---

## IPC client transport

`CoogleClient` in `src/ipc-client.ts` uses a fresh socket connection per call:

```
CoogleClient.send(method, params)
  │
  ├── connect(socketPath)
  ├── write(JSON.stringify({ id, method, params }) + "\n")
  ├── read until "\n"
  ├── JSON.parse(line) → IpcResponse
  ├── if ok: resolve(result)
  ├── if !ok: reject(new Error(error))
  └── socket.destroy()
```

A 60-second client-side timeout prevents hung calls if the daemon stops responding. The `ENOENT` / `ECONNREFUSED` error codes produce a clear "daemon not running" message rather than a raw socket error.

This stateless pattern (adapted from Whazaa's `WatcherClient`) avoids connection pooling complexity. For tool calls that may take 30–60 seconds (e.g. Drive searches over large corpora), the 60-second client timeout is a conservative floor; the daemon's configurable `callTimeoutMs` (default 120s) is the actual per-call limit.

---

## Credentials loading

The daemon loads Google OAuth credentials once at child spawn time and injects them into the child's environment. Three sources are supported:

```
loadCredentials()
  │
  ├── source == "env":
  │     read GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET from process.env
  │
  ├── source == "manual":
  │     read clientId, clientSecret from config object
  │
  └── source == "claude-json" (default):
        loadCredentialsFromClaudeJson()
          │
          ├── read claudeJsonPath (~/.claude.json)
          ├── parse JSON
          ├── navigate mcpServers[mcpServerName].env
          └── return { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET }
```

The `claude-json` source reads credentials from `~/.claude.json` where they were originally configured. This means existing users can switch to Coogle without changing their credential storage.

---

## Configuration system

Config is loaded from `~/.config/coogle/config.json` using a deep-merge strategy against hardcoded defaults. Partial configs work: only the fields present in the file override the defaults.

```typescript
const DEFAULTS: CoogleConfig = {
  socketPath: "/tmp/coogle.sock",
  mcp: { command: "uvx", args: ["workspace-mcp", "--tool-tier", "core"] },
  credentials: { source: "claude-json", claudeJsonPath: "~/.claude.json", mcpServerName: "coogle" },
  callTimeoutMs: 120_000,
  logLevel: "info",
};
```

`deepMerge` recurses into nested objects but does not merge arrays (an `args` array in config replaces the default entirely). Tilde expansion is applied to path values at runtime via `expandHome()`.

`ensureConfigDir()` is called once by `serve` on startup. It creates `~/.config/coogle/` and writes a commented default config if none exists.

---

## launchd integration

The daemon runs as a macOS `LaunchAgent` (`com.pai.coogle`) with `KeepAlive: true`. launchd restarts the daemon automatically if it exits for any reason. A `ThrottleInterval: 3` prevents restart storms.

The plist is generated dynamically by `node dist/index.js generate-plist` because it must contain:
- The absolute path to the system's `node` executable (`process.execPath`)
- The absolute path to `dist/index.js` on this machine

This avoids hardcoded paths that would break after a Node version upgrade or if coogle is cloned to a different directory.

```bash
# Generate plist for this system
node dist/index.js generate-plist > ~/Library/LaunchAgents/com.pai.coogle.plist

# Load
launchctl load ~/Library/LaunchAgents/com.pai.coogle.plist

# Logs
tail -f /tmp/coogle.log
```

---

## Setup wizard

`node dist/index.js setup` runs an interactive eight-step wizard (`src/setup.ts`):

```
runSetup()
  │
  ├── stepEnvironment()     detect node path/version, uvx presence, macOS
  ├── stepCredentials()     find creds in ~/.claude.json or prompt manually
  ├── stepWriteConfig()     write ~/.config/coogle/config.json
  ├── stepBuildCheck()      verify dist/index.js exists
  ├── stepTestDaemon()      spawn test daemon, poll for socket, IPC verify, kill
  ├── stepInstallLaunchd()  generate plist, launchctl load, wait for socket (macOS)
  ├── stepUpdateClaudeConfig()  backup ~/.claude.json, patch coogle server entry
  └── stepDone()            print status summary and command reference
```

**Test daemon pattern:** `stepTestDaemon` spawns a fresh `node dist/index.js serve` subprocess (not the launchd service), polls for the socket file with 500ms intervals up to 15 seconds, verifies via IPC (`status` then `list_tools`), then kills the subprocess. This validates the full daemon startup without modifying any persistent state.

**Claude config patching:** The wizard finds the MCP server entry in `~/.claude.json` by looking for any entry with `GOOGLE_OAUTH_CLIENT_ID` in its `env` block, falling back to the `coogle` key. It replaces the entire entry with `{ type: "stdio", command: "node", args: [indexJsPath, "mcp"] }`. The OAuth env vars are intentionally removed — coogle reads them itself.

---

## File structure

```
src/
  index.ts        CLI entry point, command dispatch, plist generator
  daemon.ts       IPC server, call queue, coogle-mcp child management
  mcp-server.ts   MCP shim: tool discovery, tools/list, tools/call proxy
  ipc-client.ts   CoogleClient: per-call IPC socket transport
  config.ts       CoogleConfig type, loader, defaults, path helpers
  setup.ts        Interactive eight-step setup wizard

dist/             Compiled JavaScript output (tsc → ES modules)
com.pai.coogle.plist  Template plist (do not use directly; use generate-plist)
```

---

## Dependency choices

| Package | Purpose | Why |
|---------|---------|-----|
| `@modelcontextprotocol/sdk` | MCP server (shim) and client (daemon) | Official SDK; `StdioClientTransport` for child management, low-level `Server` for shim to avoid schema conversion |
| `@anthropic-ai/sdk` | Listed in dependencies | Available if needed for future Anthropic API integration |
| `typescript` | Build toolchain | Type safety across the IPC boundary (shared `IpcRequest`/`IpcResponse` types) |

The project deliberately keeps its dependency count minimal. There is no HTTP server, no database, no external logging library. The IPC protocol is plain JSON over a Unix socket — readable with `nc` for debugging.

---

## Design decisions

**Why a queue instead of concurrent calls to coogle-mcp?**

`coogle-mcp` runs as a stdio subprocess. The MCP protocol over stdio is request-response — the child cannot handle interleaved requests on the same pipe. Concurrent calls would corrupt the message stream. The queue makes the concurrency model explicit and safe.

**Why fresh socket connections per IPC call?**

Persistent connections require keepalive management, reconnect logic, and per-connection state. A fresh connect-send-receive-close per call is stateless and eliminates all of that. The overhead of a Unix socket connection is microseconds — negligible compared to a `coogle-mcp` tool call that may take several seconds.

**Why read the plist path from generate-plist instead of a static template?**

The plist must contain absolute paths to `node` and `dist/index.js` that are valid on the current machine. The static template in `com.pai.coogle.plist` exists as documentation only. The `generate-plist` command produces a correct, installable plist for the current system.

**Why use the low-level MCP SDK Server in the shim?**

The higher-level `McpServer` wraps `inputSchema` objects through a Zod-based schema system. `coogle-mcp` returns raw JSON Schema objects. Passing them through `McpServer` risks schema loss or validation errors. The low-level `Server` accepts arbitrary `inputSchema` values and forwards them unchanged to Claude.

---

## stdout discipline

The MCP JSON-RPC transport uses `process.stdout` (shim) and `process.stdin`/`process.stdout` (coogle-mcp child). Any non-JSON byte on these streams breaks the protocol silently — Claude sees no tools or gets parse errors with no obvious cause.

Rules enforced throughout `mcp-server.ts`:
- All debug output goes to `process.stderr`
- `console.log` is never called in the shim code path
- All error returns go through the MCP error result format, not stderr logging

The daemon (`daemon.ts`) is not an MCP server on stdio — it can write freely to `process.stderr` for logging. The shim talks to the daemon over the IPC socket (not stdio), so the daemon's log output does not contaminate the MCP channel.
