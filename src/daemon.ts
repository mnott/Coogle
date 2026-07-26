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

import {
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
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
 * Each .json file is named after the email address (e.g. user@example.com.json).
 */
function loadAuthorizedAccounts(): string[] {
  const credDir = join(homedir(), ".google_workspace_mcp", "credentials");
  try {
    const files = readdirSync(credDir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => basename(f, ".json"))
      // The directory also holds bookkeeping files such as oauth_states.json,
      // which are not accounts. Credential files are named after the address.
      .filter((name) => name.includes("@"))
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

/** No-op executables used to neutralize the child's browser auto-open. */
const NOOP_BROWSERS = ["/usr/bin/true", "/bin/true"];

/**
 * Whether the child may open a browser window when it wants authorization.
 *
 * Off by default: the child opens one as a side effect of a failed tool call,
 * which interrupts whatever the user is doing. Authorize deliberately instead,
 * with `coogle setup`.
 */
function autoOpenAuthEnabled(): boolean {
  const env = process.env["COOGLE_AUTO_OPEN_AUTH"];
  if (env !== undefined && env !== "") {
    return env === "1" || env.toLowerCase() === "true";
  }
  return daemonConfig.autoOpenAuth === true;
}

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

  // Ensure /tmp is in ALLOWED_FILE_DIRS so attachments from /tmp work on macOS
  // (macOS resolves /tmp → /private/tmp which falls outside $HOME)
  if (!childEnv["ALLOWED_FILE_DIRS"]) {
    childEnv["ALLOWED_FILE_DIRS"] = `${homedir()}:/tmp:/private/tmp`;
  }

  // Never let a failed tool call open a browser window behind the user's back.
  // workspace-mcp calls webbrowser.open() as a side effect of an auth prompt;
  // Python's webbrowser honours $BROWSER and stops at the first entry that exits
  // 0, so a no-op binary makes that call do nothing.
  if (autoOpenAuthEnabled()) {
    process.stderr.write(
      "[coogle] Browser auto-open ENABLED (COOGLE_AUTO_OPEN_AUTH).\n"
    );
  } else {
    childEnv["BROWSER"] = NOOP_BROWSERS.find((p) => existsSync(p)) ?? "true";
    process.stderr.write(
      `[coogle] Browser auto-open disabled (BROWSER=${childEnv["BROWSER"]}). ` +
        "Set COOGLE_AUTO_OPEN_AUTH=1 to allow it.\n"
    );
  }

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
    // Preserve links: <a href="URL">text</a> → [text](URL)
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
      const clean = text.replace(/<[^>]+>/g, "").trim();
      if (!clean || clean === url) return url;
      return `[${clean}](${url})`;
    })
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

// ---------------------------------------------------------------------------
// Token freshness
//
// workspace-mcp escalates to a full re-authorization whenever *its own* token
// refresh fails, and one of those failures is structural for coogle: the child
// binds a single Google account to its one stdio session, so refreshing an
// account authorized under an alias address (the credential file is named after
// the alias, Google's ID token names the canonical account) is rejected as a
// session rebind. The refresh itself succeeded; the child still discards the
// credentials and demands re-auth.
//
// Fix: keep the on-disk access token comfortably valid so the child loads a
// valid token and never enters its refresh path at all.
// ---------------------------------------------------------------------------

/** Refresh an access token once it is within this window of expiring. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

type RefreshFailure = "invalid_grant" | "no_credentials" | "network" | "other";

class TokenRefreshError extends Error {
  constructor(message: string, readonly reason: RefreshFailure) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

/** Path of the credential file the workspace-mcp child reads for an account. */
function credentialPath(email: string): string {
  return join(homedir(), ".google_workspace_mcp", "credentials", `${email}.json`);
}

/**
 * Parse a credential-file expiry timestamp into epoch millis.
 *
 * workspace-mcp writes `datetime.isoformat()` of a naive UTC datetime, so the
 * value carries no timezone designator. `new Date()` reads such a string as
 * local time, which overstates the remaining lifetime by the UTC offset — and
 * an overstated lifetime is exactly what lets the child refresh instead of us.
 */
function parseExpiry(expiry: string | null | undefined): number {
  if (!expiry) return 0;
  const trimmed = expiry.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const ms = Date.parse(hasZone ? trimmed : `${trimmed}Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Write a credential file atomically.
 *
 * Both coogle and the child write these files. A torn write would surface in
 * the child as a parse error — and a parse error escalates to re-auth.
 */
function writeCredentialFile(credPath: string, cred: GmailCredentials): void {
  const tmp = `${credPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2), "utf-8");
  renameSync(tmp, credPath);
}

/** Accounts whose alias mismatch has already been reported. */
const reportedAliases = new Set<string>();

/**
 * Read the `email` claim out of an ID token without verifying its signature.
 * Informational only — used to explain alias/canonical account mismatches.
 */
function idTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    ) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Log once per account when its credential file is named after an alias of the
 * underlying Google account. This is the trigger for the child's session-rebind
 * rejection, so it is worth naming explicitly in the log.
 */
function noteAliasMismatch(email: string, idToken: string | undefined): void {
  const canonical = idTokenEmail(idToken);
  if (!canonical || canonical.toLowerCase() === email.toLowerCase()) return;
  if (reportedAliases.has(email)) return;
  reportedAliases.add(email);
  process.stderr.write(
    `[coogle] NOTE: "${email}" is an alias of the Google account "${canonical}".\n` +
      "[coogle]       workspace-mcp rejects the session rebind when it refreshes an\n" +
      "[coogle]       alias token, so coogle refreshes these tokens itself instead.\n"
  );
}

/**
 * Ensure the on-disk access token for an account is valid, refreshing it when it
 * is within TOKEN_REFRESH_MARGIN_MS of expiry. Returns a usable access token.
 *
 * @param force Refresh even when the stored token still looks valid.
 */
async function ensureFreshToken(email: string, force = false): Promise<string> {
  const credPath = credentialPath(email);
  if (!existsSync(credPath)) {
    throw new TokenRefreshError(`No credentials for ${email}`, "no_credentials");
  }

  let cred: GmailCredentials;
  try {
    cred = JSON.parse(readFileSync(credPath, "utf-8")) as GmailCredentials;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TokenRefreshError(
      `Credential file for ${email} is unreadable: ${msg}`,
      "other"
    );
  }

  if (!force && parseExpiry(cred.expiry) > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return cred.token;
  }

  if (!cred.refresh_token) {
    throw new TokenRefreshError(
      `No refresh token stored for ${email} — re-authorization required.`,
      "invalid_grant"
    );
  }

  process.stderr.write(`[coogle] Refreshing access token for ${email}...\n`);

  let resp: Response;
  try {
    resp = await fetch(cred.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cred.client_id,
        client_secret: cred.client_secret,
        refresh_token: cred.refresh_token,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TokenRefreshError(
      `Token refresh for ${email} could not reach Google: ${msg}`,
      "network"
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const reason: RefreshFailure = body.includes("invalid_grant")
      ? "invalid_grant"
      : "other";
    throw new TokenRefreshError(
      `Token refresh for ${email} failed: ${resp.status} ${resp.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : ""),
      reason
    );
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    id_token?: string;
  };

  cred.token = data.access_token;
  cred.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  // Google rotates refresh tokens for some clients — keep the newest one.
  if (data.refresh_token) cred.refresh_token = data.refresh_token;

  try {
    writeCredentialFile(credPath, cred);
  } catch (err) {
    // Non-fatal — the token still works for this call, the child just won't see it.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[coogle] Could not persist refreshed token for ${email}: ${msg}\n`);
  }

  noteAliasMismatch(email, data.id_token);

  return data.access_token;
}

/**
 * Refresh an account's token ahead of a tool call.
 *
 * Never blocks the call: a failure is returned so it can explain a later auth
 * prompt, but the call is still forwarded — the child may hold a usable token
 * of its own.
 */
async function preflightToken(email: string): Promise<TokenRefreshError | null> {
  try {
    await ensureFreshToken(email);
    return null;
  } catch (err) {
    const failure =
      err instanceof TokenRefreshError
        ? err
        : new TokenRefreshError(
            err instanceof Error ? err.message : String(err),
            "other"
          );
    // An unknown account is normal (validation upstream of here reports it).
    if (failure.reason !== "no_credentials") {
      process.stderr.write(`[coogle] Pre-flight refresh: ${failure.message}\n`);
    }
    return failure;
  }
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
    const token = await ensureFreshToken(email);
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

// ---------------------------------------------------------------------------
// Calendar PATCH fallback for non-organizer reminder updates
// ---------------------------------------------------------------------------

/**
 * Update only the reminders field on a Calendar event using PATCH.
 *
 * The Google Calendar API's events.patch endpoint sends only the fields
 * included in the request body, so per-user fields like reminders can be
 * updated without touching shared properties (which require organizer role).
 *
 * This is used as a fallback when workspace-mcp's manage_event (which uses
 * PUT via events.update) fails with forbiddenForNonOrganizer.
 */
async function patchCalendarReminders(
  email: string,
  eventId: string,
  useDefaultReminders: boolean | undefined,
  reminders: Array<{ method: string; minutes: number }>,
  calendarId: string = "primary"
): Promise<unknown> {
  const token = await ensureFreshToken(email); // same OAuth credentials work for Calendar

  const body: Record<string, unknown> = {
    reminders: {
      useDefault: useDefaultReminders ?? false,
      overrides: reminders,
    },
  };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  process.stderr.write(
    `[coogle] PATCH fallback: updating reminders for event ${eventId} (${email})\n`
  );

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Calendar PATCH failed: ${resp.status} ${errText}`);
  }

  const updated = (await resp.json()) as Record<string, unknown>;
  const summary = updated["summary"] || "event";
  const link = updated["htmlLink"] || "No link";

  process.stderr.write(
    `[coogle] PATCH fallback succeeded: reminders updated for '${summary}'\n`
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully updated reminders for '${summary}' (${eventId}). Link: ${link}`,
      },
    ],
  };
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
  // Handle single-message method
  if (method === "get_gmail_message_content") {
    const r = result as { content?: Array<{ type: string; text: string }> };
    const text = r?.content?.[0]?.text;
    if (!text) return result;

    // Extract the body section
    const bodyMarker = "--- BODY ---\n";
    const bodyIdx = text.indexOf(bodyMarker);
    if (bodyIdx === -1) return result;

    const body = text.slice(bodyIdx + bodyMarker.length);
    const bodyEmpty = isBodyEmpty(body);

    // Always try HTML fallback — upstream workspace-mcp strips links from HTML emails.
    // Our htmlToText() preserves links as [text](url) markdown.
    const email = params["user_google_email"] as string | undefined;
    const messageId = params["message_id"] as string | undefined;
    if (!email || !messageId) return result;

    process.stderr.write(
      `[coogle] ${bodyEmpty ? "Empty body" : "Enriching with links"} for message ${messageId}, fetching HTML...\n`
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

  // Handle batch method
  if (method === "get_gmail_messages_content_batch") {
    const r = result as { content?: Array<{ type: string; text: string }> };
    const text = r?.content?.[0]?.text;
    if (!text) return result;

    const email = params["user_google_email"] as string | undefined;
    const messageIds = params["message_ids"] as string[] | undefined;
    if (!email || !messageIds || messageIds.length === 0) return result;

    process.stderr.write(
      `[coogle] Batch HTML fallback for ${messageIds.length} messages...\n`
    );

    // Fetch all HTML fallbacks in parallel
    const fallbacks = await Promise.all(
      messageIds.map(async (messageId) => {
        try {
          const fallbackText = await fetchGmailHtmlFallback(email, messageId);
          return { messageId, fallbackText };
        } catch {
          return { messageId, fallbackText: null };
        }
      })
    );

    // Batch format: no "--- BODY ---" marker. Body starts after "Web Link:" line
    // followed by a blank line. Messages separated by blank lines before next
    // "Message ID:" header.
    //
    // Format:
    //   Message ID: <id>
    //   Subject: ...
    //   From: ...
    //   ...
    //   Web Link: ...
    //
    //   [body text]
    //
    //   Message ID: <next id>
    //   ...

    let newText = text;
    for (const fallback of fallbacks) {
      if (!fallback.fallbackText) continue;

      // Find the "Web Link:" line for this message
      const idPattern = new RegExp(`Message ID:\\s*${fallback.messageId}`);
      const idMatch = newText.match(idPattern);
      if (!idMatch) {
        process.stderr.write(
          `[coogle] Batch: could not find Message ID ${fallback.messageId} in result text\n`
        );
        continue;
      }

      // Find the "Web Link:" line after this message ID, then the blank line after it
      const searchFrom = idMatch.index!;
      const webLinkMatch = newText.slice(searchFrom).match(/Web Link:[^\n]*\n\n/);
      if (!webLinkMatch) {
        process.stderr.write(
          `[coogle] Batch: no Web Link header found after Message ID ${fallback.messageId}\n`
        );
        continue;
      }

      const bodyStart = searchFrom + webLinkMatch.index! + webLinkMatch[0].length;

      // Body ends at the next "Message ID:" line or end of text
      const nextMsgMatch = newText.slice(bodyStart).match(/\nMessage ID:\s/);
      const bodyEnd = nextMsgMatch
        ? bodyStart + nextMsgMatch.index!
        : newText.length;

      process.stderr.write(
        `[coogle] Batch: replacing body for ${fallback.messageId} (${fallback.fallbackText.length} chars).\n`
      );
      newText = newText.slice(0, bodyStart) + fallback.fallbackText + newText.slice(bodyEnd);
    }

    return {
      content: [{ type: "text" as const, text: newText }],
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auth-prompt interception
// ---------------------------------------------------------------------------

/** Signatures of workspace-mcp's "the user must authorize" responses. */
const AUTH_PROMPT_PATTERNS = [
  /ACTION REQUIRED: Google Authentication Needed/i,
  /Authentication Required: Token Expired/i,
];

interface ToolTextResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** Concatenate the text parts of a tool result. */
function resultText(result: unknown): string {
  const r = result as ToolTextResult | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.content)) return "";
  return r.content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

/**
 * Return the prompt text when a result or error is an authorization demand
 * rather than a real failure.
 */
function detectAuthPrompt(result: unknown, errMsg?: string): string | null {
  for (const text of [errMsg ?? "", resultText(result)]) {
    if (text && AUTH_PROMPT_PATTERNS.some((p) => p.test(text))) return text;
  }
  return null;
}

/** Pull the authorization URL out of an upstream auth prompt. */
function extractAuthUrl(prompt: string): string | null {
  const match = prompt.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/);
  return match ? match[0] : null;
}

/**
 * Build a short authorization message.
 *
 * workspace-mcp's prompt runs to several paragraphs and inlines all ~40 OAuth
 * scopes in the URL; this keeps the account, the reason, and the one action.
 */
function shortAuthResult(
  email: string,
  prompt: string,
  refreshError: TokenRefreshError | null
): ToolTextResult {
  const lines = [`${AUTH_MESSAGE_PREFIX}${email}.`];

  if (refreshError?.reason === "invalid_grant") {
    lines.push(
      "The stored refresh token was rejected by Google — it has expired or been revoked.",
      'If this account\'s OAuth consent screen is still in "testing" mode, Google expires',
      "refresh tokens after 7 days; publishing the consent screen to production stops it."
    );
  } else if (refreshError) {
    lines.push(`Coogle could not refresh the token: ${refreshError.message}`);
  } else {
    lines.push(
      "Coogle refreshed the token and retried once; the account is still unauthorized."
    );
  }

  // The authorization URL carries every requested scope and runs to kilobytes.
  // It goes to the log, where a human can find it, rather than into the reply.
  const url = extractAuthUrl(prompt);
  if (url) {
    process.stderr.write(`[coogle] Authorization URL for ${email}:\n${url}\n`);
    lines.push(
      "",
      "No browser was opened. To authorize, either:",
      "  - copy the authorization URL from the coogle daemon log, or",
      "  - set COOGLE_AUTO_OPEN_AUTH=1 and repeat the call to open it in a browser."
    );
  } else {
    lines.push("", "No browser was opened and no authorization URL was offered.");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}

/** First line of coogle's own short authorization message. */
const AUTH_MESSAGE_PREFIX = "Google authorization needed for ";

/** Whether a result is the short authorization message built below. */
function isAuthMessage(result: unknown): boolean {
  return resultText(result).startsWith(AUTH_MESSAGE_PREFIX);
}

/**
 * Recover from an authorization demand: force a token refresh, retry the call
 * once, and fall back to a short message if it still fails.
 *
 * Retrying is safe because the child raises this before it builds a Google
 * service client, so the original call performed no API work.
 */
async function retryAfterAuthPrompt(
  method: string,
  params: Record<string, unknown>,
  email: string,
  prompt: string,
  refreshError: TokenRefreshError | null
): Promise<unknown> {
  process.stderr.write(
    `[coogle] ${method} demanded authorization for ${email} — refreshing token and retrying once.\n`
  );

  let failure = refreshError;
  let stillPrompting = prompt;

  try {
    await ensureFreshToken(email, true);
    const retry = await enqueueCall(method, params);
    const retryPrompt = detectAuthPrompt(retry);
    if (!retryPrompt) {
      process.stderr.write(
        `[coogle] Retry after refresh succeeded — auth prompt suppressed for ${email}.\n`
      );
      return retry;
    }
    stillPrompting = retryPrompt;
  } catch (err) {
    if (err instanceof TokenRefreshError) {
      failure = err;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const retryPrompt = detectAuthPrompt(undefined, msg);
      // A different failure on retry is the real problem — surface it as-is.
      if (!retryPrompt) throw err;
      stillPrompting = retryPrompt;
    }
  }

  process.stderr.write(
    `[coogle] Authorization still required for ${email} after refresh.\n`
  );
  return shortAuthResult(email, stillPrompting, failure);
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

  // Keep the child's own token refresh out of the picture: an expired token on
  // disk is what makes it escalate to a browser-popping re-auth prompt.
  const callEmail = params["user_google_email"] as string | undefined;
  const refreshError = callEmail ? await preflightToken(callEmail) : null;

  try {
    let result = await enqueueCall(method, params);

    // The child returns an auth demand as a tool result, not a transport error.
    const prompt = detectAuthPrompt(result);
    if (prompt && callEmail) {
      result = await retryAfterAuthPrompt(method, params, callEmail, prompt, refreshError);
    }

    // Gmail post-processing needs a real message body; skip it when the reply is
    // an authorization message, or it would fire pointless Gmail API calls.
    if (!detectAuthPrompt(result) && !isAuthMessage(result)) {
      result = await postProcessGmailContent(method, params, result);
    }
    sendResponse(socket, { id, ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Some versions surface the auth demand as an error instead of a result.
    const prompt = detectAuthPrompt(undefined, msg);
    if (prompt && callEmail) {
      try {
        const recovered = await retryAfterAuthPrompt(
          method,
          params,
          callEmail,
          prompt,
          refreshError
        );
        sendResponse(socket, { id, ok: true, result: recovered });
        socket.end();
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        sendResponse(socket, { id, ok: false, error: retryMsg });
        socket.end();
        return;
      }
    }

    // Calendar PATCH fallback: when manage_event fails with forbiddenForNonOrganizer
    // and reminders were requested, retry with a direct Calendar API PATCH that only
    // sends the reminders field (which is per-user, not a shared property).
    if (
      method === "manage_event" &&
      msg.includes("forbiddenForNonOrganizer") &&
      params["reminders"]
    ) {
      try {
        const patchResult = await patchCalendarReminders(
          params["user_google_email"] as string,
          params["event_id"] as string,
          params["use_default_reminders"] as boolean | undefined,
          params["reminders"] as Array<{ method: string; minutes: number }>,
          (params["calendar_id"] as string) || "primary"
        );
        sendResponse(socket, { id, ok: true, result: patchResult });
        socket.end();
        return;
      } catch (patchErr) {
        const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
        sendResponse(socket, { id, ok: false, error: `Original: ${msg}\nPATCH fallback: ${patchMsg}` });
        socket.end();
        return;
      }
    }

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
