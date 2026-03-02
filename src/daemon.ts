/**
 * daemon.ts — The persistent coogle daemon
 *
 * Spawns a single coogle-mcp child process and
 * multiplexes IPC requests from multiple MCP shim clients through it.
 *
 * Architecture:
 *   MCP shims (Claude sessions) → Unix socket → daemon → coogle-mcp child
 *
 * IPC protocol: NDJSON over Unix Domain Socket (same pattern as Whazaa).
 *
 * Request  (shim → daemon):
 *   { "id": "uuid", "method": "tool_name_or_special", "params": {} }
 *
 * Response (daemon → shim):
 *   { "id": "uuid", "ok": true, "result": <any> }
 *   { "id": "uuid", "ok": false, "error": "message" }
 *
 * Special methods:
 *   list_tools    — List tools from coogle-mcp child
 *   status        — Return daemon status
 *   restart_child — Kill and respawn coogle-mcp child
 *
 * All other methods are forwarded as coogle-mcp tool calls.
 */

import { existsSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createServer, Socket, Server } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import { ToolDefinition } from "./ipc-client.js";
import { CoogleConfig, expandHome, ensureConfigDir } from "./config.js";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

interface IpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Request queue (serializes concurrent calls to coogle-mcp)
// ---------------------------------------------------------------------------

interface QueuedCall {
  method: string;
  params: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

let mcpClient: Client | null = null;
let isConnected = false;
let startTime = Date.now();

const callQueue: QueuedCall[] = [];

// Mutex: only one drain loop runs at a time
let processingPromise: Promise<void> | null = null;

// Respawn cooldown
let lastRespawnAttempt = 0;
const RESPAWN_COOLDOWN_MS = 3_000;

// Config reference (set by serve())
let daemonConfig: CoogleConfig;

// Authorized accounts (scanned from credential files)
let authorizedAccounts: string[] = [];

// Cached tool definitions (populated on first list_tools call)
let knownTools: Map<string, ToolDefinition> = new Map();

// ---------------------------------------------------------------------------
// Account scanning
// ---------------------------------------------------------------------------

/**
 * Scan ~/.google_workspace_mcp/credentials/ for authorized Google accounts.
 * Each .json file is named after the email address (e.g. mnott@mnott.de.json).
 */
function loadAuthorizedAccounts(): string[] {
  const credDir = join(homedir(), ".google_workspace_mcp", "credentials");
  try {
    const files = readdirSync(credDir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => basename(f, ".json"))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Credentials helper
// ---------------------------------------------------------------------------

/**
 * Load Google OAuth credentials based on the configured source.
 * Returns an env record to merge into the child environment.
 */
function loadCredentials(): Record<string, string> {
  const creds = daemonConfig.credentials;

  if (creds.source === "env") {
    const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
    const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
    if (clientId || clientSecret) {
      process.stderr.write("[coogle] Loaded credentials from env vars.\n");
    }
    const result: Record<string, string> = {};
    if (clientId) result["GOOGLE_OAUTH_CLIENT_ID"] = clientId;
    if (clientSecret) result["GOOGLE_OAUTH_CLIENT_SECRET"] = clientSecret;
    return result;
  }

  if (creds.source === "manual") {
    const result: Record<string, string> = {};
    if (creds.clientId) result["GOOGLE_OAUTH_CLIENT_ID"] = creds.clientId;
    if (creds.clientSecret) result["GOOGLE_OAUTH_CLIENT_SECRET"] = creds.clientSecret;
    if (Object.keys(result).length > 0) {
      process.stderr.write("[coogle] Loaded credentials from config (manual).\n");
    }
    return result;
  }

  // Default: claude-json
  return loadCredentialsFromClaudeJson();
}

/**
 * Read Google OAuth credentials from ~/.claude.json (or configured path).
 * Falls back gracefully if the file is missing or malformed.
 */
function loadCredentialsFromClaudeJson(): Record<string, string> {
  const rawPath = daemonConfig.credentials.claudeJsonPath ?? "~/.claude.json";
  const claudeJsonPath = expandHome(rawPath);
  const backupPath = claudeJsonPath + ".backup";
  const serverKey = daemonConfig.credentials.mcpServerName ?? "coogle";

  // Try to extract creds from a parsed claude.json structure
  function extractCreds(filePath: string): Record<string, string> | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;

      // Try configured key first, then legacy "workspace" key, then any server with Google creds
      const keysToTry = [serverKey];
      if (serverKey !== "workspace") keysToTry.push("workspace");

      for (const key of keysToTry) {
        const entry = mcpServers?.[key] as Record<string, unknown> | undefined;
        const env = entry?.["env"] as Record<string, string> | undefined;
        if (env && typeof env === "object" && env["GOOGLE_OAUTH_CLIENT_ID"]) {
          const result: Record<string, string> = {};
          for (const [k, v] of Object.entries(env)) {
            if (typeof v === "string") result[k] = v;
          }
          process.stderr.write(
            `[coogle] Loaded credentials from ${filePath} (server: "${key}", keys: ${Object.keys(result).join(", ")})\n`
          );
          return result;
        }
      }
    } catch {
      // ignore — try next source
    }
    return null;
  }

  // Source 1: main claude.json
  const fromMain = extractCreds(claudeJsonPath);
  if (fromMain) return fromMain;

  // Source 2: backup (original creds before coogle setup stripped env vars)
  const fromBackup = extractCreds(backupPath);
  if (fromBackup) return fromBackup;

  process.stderr.write(
    `[coogle] No Google OAuth credentials found in ${claudeJsonPath} or ${backupPath}\n`
  );
  return {};
}

// ---------------------------------------------------------------------------
// coogle-mcp child management
// ---------------------------------------------------------------------------

/**
 * Resolve the MCP command to an absolute path if possible.
 * If it's a bare command name (no path separator), look it up via PATH.
 */
export function resolveMcpCommand(command: string): string {
  if (command.includes("/")) {
    // Already an absolute or relative path — use as-is
    return command;
  }
  // Search PATH for the command
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  for (const dir of pathDirs) {
    const full = join(dir, command);
    if (existsSync(full)) {
      return full;
    }
  }
  // Not found — return bare name and let the OS handle the error
  return command;
}

/**
 * Spawn the coogle-mcp child via StdioClientTransport only.
 * Credentials are loaded based on config and merged into the child env.
 */
async function spawnChild(): Promise<void> {
  process.stderr.write("[coogle] Spawning coogle-mcp child...\n");

  // Disconnect and clear any existing client first
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch {
      // ignore
    }
    mcpClient = null;
    isConnected = false;
  }

  // Build child environment: our process env + credentials
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const creds = loadCredentials();
  Object.assign(childEnv, creds);

  const command = resolveMcpCommand(daemonConfig.mcp.command);
  const args = daemonConfig.mcp.args;

  process.stderr.write(`[coogle] Running: ${command} ${args.join(" ")}\n`);

  const transport = new StdioClientTransport({
    command,
    args,
    env: childEnv,
  });

  const client = new Client(
    { name: "coogle", version: "0.1.0" },
    { capabilities: {} }
  );

  mcpClient = client;

  try {
    await client.connect(transport);
    isConnected = true;
    process.stderr.write("[coogle] Connected to coogle-mcp child.\n");

    // Watch for transport close — mark disconnected for auto-respawn
    transport.onclose = () => {
      process.stderr.write("[coogle] Transport closed.\n");
      isConnected = false;
      mcpClient = null;
      drainQueueWithError(new Error("coogle-mcp transport closed"));
    };

    transport.onerror = (err) => {
      process.stderr.write(`[coogle] Transport error: ${err.message}\n`);
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[coogle] Failed to connect to child: ${msg}\n`);
    isConnected = false;
    mcpClient = null;
    throw new Error(`Failed to connect to coogle-mcp: ${msg}`);
  }
}

/**
 * Drain the queue by rejecting all pending calls with an error.
 * Called when the child dies unexpectedly.
 */
function drainQueueWithError(err: Error): void {
  processingPromise = null;
  const pending = callQueue.splice(0);
  for (const call of pending) {
    call.reject(err);
  }
}

// ---------------------------------------------------------------------------
// Queue drain loop with mutex and auto-respawn
// ---------------------------------------------------------------------------

/**
 * Drain all queued calls in order. Called by enqueueAndProcess.
 * Includes per-call timeout and auto-respawn on disconnect.
 */
async function drainQueue(): Promise<void> {
  while (callQueue.length > 0) {
    // Auto-respawn if child crashed
    if (!isConnected || !mcpClient) {
      const now = Date.now();
      if (now - lastRespawnAttempt < RESPAWN_COOLDOWN_MS) {
        process.stderr.write(
          `[coogle] Respawn on cooldown (${RESPAWN_COOLDOWN_MS}ms). Rejecting queued call.\n`
        );
        const item = callQueue.shift()!;
        item.reject(new Error("coogle-mcp child is not connected (respawn on cooldown)"));
        continue;
      }
      lastRespawnAttempt = now;
      process.stderr.write("[coogle] Child disconnected — attempting respawn...\n");
      try {
        await spawnChild();
        process.stderr.write("[coogle] Respawn succeeded.\n");
      } catch (respawnErr) {
        const msg = respawnErr instanceof Error ? respawnErr.message : String(respawnErr);
        process.stderr.write(`[coogle] Respawn failed: ${msg}\n`);
        const item = callQueue.shift()!;
        item.reject(new Error(`coogle-mcp respawn failed: ${msg}`));
        continue;
      }
    }

    const item = callQueue.shift()!;
    const timeoutMs = daemonConfig.callTimeoutMs;

    try {
      const result = await Promise.race([
        mcpClient!.callTool({ name: item.method, arguments: item.params }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tool call timed out after ${timeoutMs / 1000}s`)),
            timeoutMs
          )
        ),
      ]);
      item.resolve(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      item.reject(new Error(msg));
    }
  }
}

/**
 * Enqueue a tool call and ensure the drain loop is running (mutex).
 */
function enqueueAndProcess(item: QueuedCall): void {
  callQueue.push(item);
  if (!processingPromise) {
    processingPromise = drainQueue().finally(() => {
      processingPromise = null;
    });
  }
}

/**
 * Enqueue a tool call and return a promise that resolves with the result.
 */
function enqueueCall(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    enqueueAndProcess({ method, params, resolve, reject });
  });
}

// ---------------------------------------------------------------------------
// Gmail HTML fallback
// ---------------------------------------------------------------------------

/** Minimum meaningful body length after stripping common footers. */
const MIN_BODY_LENGTH = 50;

/** Common mailing list / signature patterns that don't count as real content. */
const FOOTER_PATTERNS = [
  /^_{3,}/m,                          // _______________ separator
  /mailing list$/im,
  /mailman\/listinfo/i,
  /unsubscribe/i,
];

/**
 * Check whether a Gmail body looks empty or contains only footers/signatures.
 */
function isBodyEmpty(body: string): boolean {
  if (!body || body.includes("[No readable content found]")) return true;

  // Strip lines that match known footer patterns
  let stripped = body;
  for (const pat of FOOTER_PATTERNS) {
    stripped = stripped.replace(pat, "");
  }
  stripped = stripped.replace(/https?:\/\/\S+/g, "").trim();

  return stripped.length < MIN_BODY_LENGTH;
}

/**
 * Convert HTML to readable plain text (no dependencies).
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface GmailCredentials {
  token: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
  expiry: string;
  token_uri: string;
}

/**
 * Load per-account OAuth credentials and refresh the token if expired.
 */
async function getGmailToken(email: string): Promise<string> {
  const credPath = join(homedir(), ".google_workspace_mcp", "credentials", `${email}.json`);
  if (!existsSync(credPath)) {
    throw new Error(`No credentials for ${email}`);
  }

  const cred: GmailCredentials = JSON.parse(readFileSync(credPath, "utf-8"));

  // Check if token is still valid (with 60s buffer)
  const expiryMs = new Date(cred.expiry).getTime();
  if (expiryMs > Date.now() + 60_000) {
    return cred.token;
  }

  // Refresh
  process.stderr.write(`[coogle] Refreshing Gmail token for ${email}...\n`);
  const resp = await fetch(cred.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };

  // Write updated token back
  cred.token = data.access_token;
  cred.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  try {
    writeFileSync(credPath, JSON.stringify(cred, null, 2), "utf-8");
  } catch {
    // Non-fatal — token still works for this call
  }

  return data.access_token;
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/**
 * Recursively find the text/html MIME part in a Gmail message payload.
 */
function findHtmlPart(part: GmailPart): string | null {
  if (part.mimeType === "text/html" && part.body?.data) {
    // Gmail uses base64url encoding — Node's Buffer handles both variants
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const found = findHtmlPart(child);
    if (found) return found;
  }
  return null;
}

/**
 * Fetch a Gmail message directly via the Gmail API and extract readable text
 * from the HTML part. Used as a fallback when workspace-mcp returns an empty body.
 */
async function fetchGmailHtmlFallback(email: string, messageId: string): Promise<string | null> {
  try {
    const token = await getGmailToken(email);
    const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(email)}/messages/${encodeURIComponent(messageId)}?format=full`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      process.stderr.write(
        `[coogle] Gmail API fallback failed: ${resp.status} ${resp.statusText}\n`
      );
      return null;
    }

    const msg = (await resp.json()) as { payload: GmailPart };
    const html = findHtmlPart(msg.payload);
    if (!html) return null;

    const text = htmlToText(html);
    return text.length > 0 ? text : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[coogle] Gmail HTML fallback error: ${msg}\n`);
    return null;
  }
}

/**
 * Post-process a get_gmail_message_content result.
 * If the body is empty/useless, re-fetch from Gmail API and extract HTML content.
 */
async function postProcessGmailContent(
  method: string,
  params: Record<string, unknown>,
  result: unknown
): Promise<unknown> {
  if (method !== "get_gmail_message_content") return result;

  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r?.content?.[0]?.text;
  if (!text) return result;

  // Extract the body section
  const bodyMarker = "--- BODY ---\n";
  const bodyIdx = text.indexOf(bodyMarker);
  if (bodyIdx === -1) return result;

  const body = text.slice(bodyIdx + bodyMarker.length);
  if (!isBodyEmpty(body)) return result;

  // Body is empty — attempt fallback
  const email = params["user_google_email"] as string | undefined;
  const messageId = params["message_id"] as string | undefined;
  if (!email || !messageId) return result;

  process.stderr.write(
    `[coogle] Empty body detected for message ${messageId}, attempting HTML fallback...\n`
  );

  const fallbackText = await fetchGmailHtmlFallback(email, messageId);
  if (!fallbackText) {
    process.stderr.write("[coogle] HTML fallback produced no content.\n");
    return result;
  }

  process.stderr.write(
    `[coogle] HTML fallback succeeded (${fallbackText.length} chars).\n`
  );

  // Build a new result with the fallback body (avoid mutating frozen SDK objects)
  const header = text.slice(0, bodyIdx + bodyMarker.length);
  const newText = header + fallbackText;
  return {
    content: [{ type: "text" as const, text: newText }],
  };
}

// ---------------------------------------------------------------------------
// IPC server
// ---------------------------------------------------------------------------

function sendResponse(socket: Socket, response: IpcResponse): void {
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch {
    // Socket may already be closed
  }
}

/**
 * Handle a single IPC request.
 */
async function handleRequest(request: IpcRequest, socket: Socket): Promise<void> {
  const { id, method, params } = request;

  if (method === "status") {
    sendResponse(socket, {
      id,
      ok: true,
      result: {
        connected: isConnected,
        queueLength: callQueue.length,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        childRunning: mcpClient !== null,
      },
    });
    socket.end();
    return;
  }

  if (method === "list_tools") {
    if (!mcpClient || !isConnected) {
      sendResponse(socket, {
        id,
        ok: false,
        error: "coogle-mcp child is not connected",
      });
      socket.end();
      return;
    }

    try {
      // Refresh authorized accounts on every list_tools call
      authorizedAccounts = loadAuthorizedAccounts();
      const defaultAcct = daemonConfig.defaultAccount || "";
      const accountList = authorizedAccounts.join(", ");

      const toolsResult = await mcpClient.listTools();
      const tools: ToolDefinition[] = toolsResult.tools.map((t) => {
        const schema = t.inputSchema as Record<string, unknown>;
        const required = (schema.required ?? []) as string[];
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        let description = t.description ?? "";

        // Enrich tools that require user_google_email
        if (required.includes("user_google_email") && authorizedAccounts.length > 0) {
          const suffix = defaultAcct
            ? `\n\nAuthorized Google accounts: ${accountList}. Default: ${defaultAcct}`
            : `\n\nAuthorized Google accounts: ${accountList}.`;
          description += suffix;

          // Also enrich the property description in the schema
          if (properties["user_google_email"]) {
            const propDesc = defaultAcct
              ? `Google account email. Authorized: ${accountList}. Default: ${defaultAcct}`
              : `Google account email. Authorized: ${accountList}.`;
            properties["user_google_email"] = {
              ...properties["user_google_email"],
              description: propDesc,
            };
          }
        }

        return {
          name: t.name,
          description,
          inputSchema: { ...schema, properties },
        };
      });

      // Cache tool definitions for validation
      knownTools = new Map(tools.map((t) => [t.name, t]));

      sendResponse(socket, { id, ok: true, result: tools });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  if (method === "restart_child") {
    try {
      await spawnChild();
      sendResponse(socket, { id, ok: true, result: { restarted: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResponse(socket, { id, ok: false, error: msg });
    }
    socket.end();
    return;
  }

  // All other methods are coogle-mcp tool calls.
  // Validate user_google_email if the tool requires it.
  const toolDef = knownTools.get(method);
  if (toolDef) {
    const required = ((toolDef.inputSchema.required ?? []) as string[]);
    if (required.includes("user_google_email")) {
      const email = params["user_google_email"] as string | undefined;
      const defaultAcct = daemonConfig.defaultAccount || "";

      if (!email) {
        if (defaultAcct && authorizedAccounts.includes(defaultAcct)) {
          // Inject default account
          params["user_google_email"] = defaultAcct;
        } else if (authorizedAccounts.length > 0) {
          const accountList = authorizedAccounts.join(", ");
          sendResponse(socket, {
            id,
            ok: false,
            error: `Missing required parameter "user_google_email".\n\nAuthorized accounts: ${accountList}\n\nSet a default in ~/.config/coogle/config.json:\n  "defaultAccount": "${authorizedAccounts[0]}"`,
          });
          socket.end();
          return;
        }
        // If no authorized accounts found, let the call through — workspace-mcp will handle the error
      } else if (authorizedAccounts.length > 0 && !authorizedAccounts.includes(email)) {
        const accountList = authorizedAccounts.join(", ");
        sendResponse(socket, {
          id,
          ok: false,
          error: `Account "${email}" is not authorized in Coogle.\n\nAuthorized accounts: ${accountList}\n\nTo authorize a new account, run this in a terminal:\n  npx @tekmidian/coogle setup\nThen follow the prompts to add the account.`,
        });
        socket.end();
        return;
      }
    }
  }

  try {
    let result = await enqueueCall(method, params);
    result = await postProcessGmailContent(method, params, result);
    sendResponse(socket, { id, ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendResponse(socket, { id, ok: false, error: msg });
  }
  socket.end();
}

/**
 * Start the Unix Domain Socket IPC server.
 */
function startIpcServer(socketPath: string): Server {
  // Remove stale socket file from a previous run
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
      process.stderr.write("[coogle] Removed stale socket file.\n");
    } catch {
      // If we can't remove it, bind will fail with a clear error
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;

      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      let request: IpcRequest;
      try {
        request = JSON.parse(line) as IpcRequest;
      } catch {
        sendResponse(socket, { id: "?", ok: false, error: "Invalid JSON" });
        socket.destroy();
        return;
      }

      handleRequest(request, socket).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id: request.id, ok: false, error: msg });
        socket.destroy();
      });
    });

    socket.on("error", () => {
      // Client disconnected — nothing to do
    });
  });

  server.on("error", (err) => {
    process.stderr.write(`[coogle] IPC server error: ${err}\n`);
  });

  server.listen(socketPath, () => {
    process.stderr.write(
      `[coogle] IPC server listening on ${socketPath}\n`
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main daemon entry point
// ---------------------------------------------------------------------------

export async function serve(config: CoogleConfig): Promise<void> {
  daemonConfig = config;
  startTime = Date.now();

  // Ensure config directory and default config exist
  ensureConfigDir();

  // Scan authorized accounts at startup
  authorizedAccounts = loadAuthorizedAccounts();
  if (authorizedAccounts.length > 0) {
    process.stderr.write(
      `[coogle] Authorized accounts: ${authorizedAccounts.join(", ")}\n`
    );
    if (config.defaultAccount) {
      process.stderr.write(`[coogle] Default account: ${config.defaultAccount}\n`);
    }
  } else {
    process.stderr.write("[coogle] No authorized accounts found.\n");
  }

  process.stderr.write("[coogle] Starting daemon...\n");
  process.stderr.write(
    `[coogle] Socket: ${config.socketPath}\n`
  );

  try {
    await spawnChild();
  } catch (err) {
    process.stderr.write(
      `[coogle] WARNING: Could not connect to coogle-mcp at startup: ${err}\n`
    );
    process.stderr.write(
      "[coogle] Will retry on first IPC call. Continuing...\n"
    );
  }

  const server = startIpcServer(config.socketPath);

  const shutdown = (signal: string): void => {
    process.stderr.write(`\n[coogle] ${signal} received. Stopping.\n`);

    server.close();
    try {
      unlinkSync(config.socketPath);
    } catch {
      // ignore
    }

    if (mcpClient) {
      mcpClient.close().catch(() => {});
    }

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep process alive
  await new Promise(() => {});
}
