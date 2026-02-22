/**
 * setup.ts — Interactive first-time setup for coogle
 *
 * Run with: node dist/index.js setup
 *
 * Walks the user through:
 *   1. Environment detection (node, uvx, OS)
 *   2. Credential detection (from ~/.claude.json or prompted)
 *   3. Writing config to ~/.config/coogle/config.json
 *   4. Build check (dist/index.js exists)
 *   5. Test daemon startup (spawn, connect via IPC, verify tools)
 *   6. Install launchd service (macOS only, optional)
 *   7. Update Claude Code config (optional)
 *   8. Done summary
 */

import { createInterface } from "node:readline";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { CoogleClient } from "./ipc-client.js";
import { CONFIG_DIR, CONFIG_FILE, expandHome } from "./config.js";
import { resolveMcpCommand } from "./daemon.js";

// ---------------------------------------------------------------------------
// ANSI color helpers (no external deps)
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

function ok(msg: string): void {
  process.stdout.write(`  ${green("✓")} ${msg}\n`);
}
function fail(msg: string): void {
  process.stdout.write(`  ${red("✗")} ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`  ${yellow("!")} ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`  ${dim("·")} ${msg}\n`);
}

function header(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
  process.stdout.write("─".repeat(title.length) + "\n");
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

let rl: ReturnType<typeof createInterface> | null = null;

function getReadline(): ReturnType<typeof createInterface> {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // Suppress "close" events that would crash on stdin end
    rl.on("close", () => {});
  }
  return rl;
}

function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** Prompt the user for a line of input */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    getReadline().question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Prompt with a Y/n choice. Returns true for yes, false for no. */
async function promptYesNo(
  question: string,
  defaultYes = true
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`  ${question} ${dim(hint)}: `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/** Show first 4 + last 4 chars with middle masked */
function maskSecret(s: string): string {
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

/** Find a command in PATH. Returns the full path or null if not found. */
function checkCommand(name: string): string | null {
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  for (const dir of pathDirs) {
    const full = join(dir, name);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 1: Environment detection
// ---------------------------------------------------------------------------

interface EnvInfo {
  nodePath: string;
  nodeVersion: string;
  uvxPath: string | null;
  isMacOS: boolean;
}

function detectEnvironment(): EnvInfo {
  const nodePath = process.execPath;
  const nodeVersion = process.version;
  const uvxPath = checkCommand("uvx");
  const isMacOS = platform() === "darwin";

  return { nodePath, nodeVersion, uvxPath, isMacOS };
}

async function stepEnvironment(): Promise<EnvInfo> {
  header("Step 1: Detecting Environment");

  const env = detectEnvironment();

  info(`Node:  ${cyan(env.nodePath)} (${env.nodeVersion})`);
  if (env.nodeVersion.startsWith("v") && parseInt(env.nodeVersion.slice(1)) >= 18) {
    ok("Node version is supported");
  } else {
    warn(`Node ${env.nodeVersion} may be too old. Node 18+ recommended.`);
  }

  if (env.uvxPath) {
    ok(`uvx found: ${cyan(env.uvxPath)}`);
  } else {
    fail("uvx not found in PATH");
    warn("Install with: pip install uv  OR  brew install uv");
    warn("uvx is required to run coogle-mcp");
  }

  if (env.isMacOS) {
    ok("macOS detected — launchd service installation available");
  } else {
    warn(`Platform: ${platform()} — launchd service not available`);
  }

  return env;
}

// ---------------------------------------------------------------------------
// Step 2: Credential detection
// ---------------------------------------------------------------------------

interface CredentialInfo {
  source: "claude-json" | "manual";
  clientId: string;
  clientSecret: string;
  claudeJsonMcpServerName?: string;
}

async function stepCredentials(): Promise<CredentialInfo> {
  header("Step 2: Google OAuth Credentials");

  const claudeJsonPath = join(homedir(), ".claude.json");
  const claudeJsonBackupPath = join(homedir(), ".claude.json.backup");
  const configFilePath = join(homedir(), ".config", "coogle", "config.json");

  // Helper: scan an mcpServers object for Google OAuth env vars
  function findCredsInMcpServers(
    mcpServers: Record<string, unknown> | undefined,
    label: string
  ): CredentialInfo | null {
    for (const [serverName, serverConfig] of Object.entries(mcpServers ?? {})) {
      const srvCfg = serverConfig as Record<string, unknown>;
      const env = srvCfg["env"] as Record<string, string> | undefined;
      if (!env) continue;
      const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
      const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
      if (clientId && clientSecret) {
        ok(`Found credentials in ${cyan(label)} (server: "${serverName}")`);
        info(`Client ID:     ${cyan(maskSecret(clientId))}`);
        info(`Client Secret: ${cyan(maskSecret(clientSecret))}`);
        return { source: "claude-json", clientId, clientSecret, claudeJsonMcpServerName: serverName };
      }
    }
    return null;
  }

  // Source 1: Existing coogle config with manual credentials
  if (existsSync(configFilePath)) {
    try {
      const raw = readFileSync(configFilePath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const creds = cfg["credentials"] as Record<string, unknown> | undefined;
      if (creds?.["source"] === "manual" && creds["clientId"] && creds["clientSecret"]) {
        const clientId = creds["clientId"] as string;
        const clientSecret = creds["clientSecret"] as string;
        ok(`Found credentials in existing config ${cyan("~/.config/coogle/config.json")}`);
        info(`Client ID:     ${cyan(maskSecret(clientId))}`);
        info(`Client Secret: ${cyan(maskSecret(clientSecret))}`);
        return { source: "manual", clientId, clientSecret };
      }
    } catch {
      // ignore — try other sources
    }
  }

  // Source 2: ~/.claude.json (any server with Google OAuth env vars)
  if (existsSync(claudeJsonPath)) {
    try {
      const raw = readFileSync(claudeJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result = findCredsInMcpServers(
        parsed["mcpServers"] as Record<string, unknown> | undefined,
        "~/.claude.json"
      );
      if (result) return result;
    } catch (err) {
      warn(`Could not parse ~/.claude.json: ${err}`);
    }
  }

  // Source 3: ~/.claude.json.backup (original creds before first coogle setup)
  if (existsSync(claudeJsonBackupPath)) {
    try {
      const raw = readFileSync(claudeJsonBackupPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result = findCredsInMcpServers(
        parsed["mcpServers"] as Record<string, unknown> | undefined,
        "~/.claude.json.backup"
      );
      if (result) return result;
    } catch {
      // ignore
    }
  }

  warn("No existing Google OAuth credentials found");

  // Fall through to manual entry
  info("Please provide Google OAuth credentials manually.");
  info(
    dim(
      "Get these from Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client IDs"
    )
  );
  process.stdout.write("\n");

  const clientId = await prompt("  Google OAuth Client ID: ");
  const clientSecret = await prompt("  Google OAuth Client Secret: ");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth credentials are required. Cannot continue setup."
    );
  }

  ok(`Client ID:     ${maskSecret(clientId)}`);
  ok(`Client Secret: ${maskSecret(clientSecret)}`);

  return { source: "manual", clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Step 3: Write config
// ---------------------------------------------------------------------------

async function stepWriteConfig(
  env: EnvInfo,
  creds: CredentialInfo,
  socketPath: string
): Promise<void> {
  header("Step 3: Writing Config");

  const mcpCommand = env.uvxPath ?? "uvx";
  const mcpArgs = ["coogle-mcp", "--tool-tier", "core"];

  // Build the config object
  let configObj: Record<string, unknown>;

  if (creds.source === "claude-json") {
    configObj = {
      socketPath,
      mcp: {
        command: mcpCommand,
        args: mcpArgs,
      },
      credentials: {
        source: "claude-json",
        claudeJsonPath: "~/.claude.json",
        mcpServerName: creds.claudeJsonMcpServerName ?? "coogle",
      },
      callTimeoutMs: 120000,
      logLevel: "info",
    };
  } else {
    configObj = {
      socketPath,
      mcp: {
        command: mcpCommand,
        args: mcpArgs,
      },
      credentials: {
        source: "manual",
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      },
      callTimeoutMs: 120000,
      logLevel: "info",
    };
  }

  info(`Config file:  ${cyan(CONFIG_FILE)}`);
  info(`Socket path:  ${cyan(socketPath)}`);
  info(`MCP command:  ${cyan(mcpCommand)}`);
  info(`MCP args:     ${cyan(mcpArgs.join(" "))}`);
  info(
    `Credentials:  ${creds.source === "claude-json"
      ? cyan("from ~/.claude.json (server: " + (creds.claudeJsonMcpServerName ?? "coogle") + ")")
      : cyan("manual (stored in config)")}`
  );

  // Write config
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(configObj, null, 2) + "\n", "utf-8");
    ok("Config saved");
  } catch (err) {
    throw new Error(`Failed to write config to ${CONFIG_FILE}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Build check
// ---------------------------------------------------------------------------

function getIndexJsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const distDir = dirname(__filename);
  return join(distDir, "index.js");
}

async function stepBuildCheck(): Promise<string> {
  header("Step 4: Build Check");

  const indexJsPath = getIndexJsPath();

  if (existsSync(indexJsPath)) {
    ok(`dist/index.js exists: ${cyan(indexJsPath)}`);
  } else {
    fail(`dist/index.js not found at ${indexJsPath}`);
    throw new Error(
      `Build output not found. Run: bun run build\n  (or: npx tsc)`
    );
  }

  return indexJsPath;
}

// ---------------------------------------------------------------------------
// Step 5: Test daemon startup
// ---------------------------------------------------------------------------

async function stepTestDaemon(
  indexJsPath: string,
  socketPath: string
): Promise<{ toolCount: number }> {
  header("Step 5: Test Daemon Startup");

  const STARTUP_TIMEOUT_MS = 15_000;
  const POLL_INTERVAL_MS = 500;

  // Remove stale socket from previous test
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }

  info("Spawning coogle daemon subprocess...");

  // Spawn daemon as a child process (detached from stdin so it doesn't compete)
  const child = spawn(process.execPath, [indexJsPath, "serve"], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
    env: {
      ...process.env,
    },
  });

  let childExited = false;
  let childError: string | null = null;

  child.on("exit", (code) => {
    childExited = true;
    if (code !== 0 && code !== null) {
      childError = `Daemon exited with code ${code}`;
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    // Log notable lines in dim text
    if (line.includes("ERROR") || line.includes("FATAL")) {
      process.stdout.write(`  ${dim("[daemon]")} ${red(line)}\n`);
    }
  });

  // Wait for socket to appear (poll)
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let socketReady = false;

  while (Date.now() < deadline) {
    if (childExited) {
      break;
    }
    if (existsSync(socketPath)) {
      socketReady = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!socketReady || childExited) {
    // Kill child before throwing
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }

    if (childError) {
      throw new Error(`Daemon failed to start: ${childError}`);
    }
    throw new Error(
      `Daemon did not create socket at ${socketPath} within ${STARTUP_TIMEOUT_MS / 1000}s.\n` +
        `  Check credentials and that coogle-mcp is accessible.`
    );
  }

  ok(`IPC socket ready: ${cyan(socketPath)}`);

  // Connect via IPC client and verify
  const client = new CoogleClient(socketPath);

  let toolCount = 0;
  try {
    // Small delay to let coogle-mcp child fully initialize
    await sleep(1000);

    const status = await client.status();
    const s = status as {
      connected?: boolean;
      childRunning?: boolean;
      uptime?: number;
    };

    if (s.connected) {
      ok(`Connected to coogle-mcp child`);
    } else {
      warn(`coogle-mcp child not yet connected (it may still be starting)`);
    }

    // List tools — this may take a few seconds on first startup
    info("Discovering tools (this may take a moment)...");
    const tools = await client.listTools();
    toolCount = tools.length;

    if (toolCount > 0) {
      ok(`Tools discovered: ${cyan(String(toolCount))}`);
    } else {
      warn("No tools found — coogle-mcp may have failed to start");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`IPC test failed: ${msg}`);
    warn("Daemon may still work — credentials are loaded at connect time.");
  } finally {
    // Always kill the test daemon
    info("Shutting down test daemon...");
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Wait briefly for it to exit
    await sleep(500);
    // Remove socket file if it still exists
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
    ok("Test daemon stopped");
  }

  return { toolCount };
}

// ---------------------------------------------------------------------------
// Step 6: Install launchd service (macOS only)
// ---------------------------------------------------------------------------

async function stepInstallLaunchd(
  indexJsPath: string,
  socketPath: string
): Promise<boolean> {
  header("Step 6: Install launchd Service");

  const plistPath = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "com.pai.coogle.plist"
  );

  const alreadyInstalled = existsSync(plistPath);
  if (alreadyInstalled) {
    info(`Plist already exists: ${cyan(plistPath)}`);
  }

  const doInstall = await promptYesNo(
    alreadyInstalled
      ? "Reinstall launchd service (overwrites existing plist)?"
      : "Install launchd service (auto-start on login)?",
    true
  );

  if (!doInstall) {
    warn("Skipping launchd service installation");
    return false;
  }

  // Generate plist content
  const plistContent = generatePlist(indexJsPath, socketPath);

  // Unload existing plist if installed
  if (alreadyInstalled) {
    info("Unloading existing service...");
    await runCommand("launchctl", ["unload", plistPath]).catch(() => {
      // ignore errors — plist may not be loaded
    });
    await sleep(500);
  }

  // Write plist
  try {
    const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }
    writeFileSync(plistPath, plistContent, "utf-8");
    ok(`Plist written: ${cyan(plistPath)}`);
  } catch (err) {
    throw new Error(`Failed to write plist: ${err}`);
  }

  // Load the service
  info("Loading service with launchctl...");
  try {
    await runCommand("launchctl", ["load", plistPath]);
    ok("Service loaded");
  } catch (err) {
    throw new Error(`launchctl load failed: ${err}`);
  }

  // Wait for socket to appear (daemon startup)
  info("Waiting for daemon to start (up to 10 seconds)...");
  const deadline = Date.now() + 10_000;
  let running = false;

  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      running = true;
      break;
    }
    await sleep(500);
  }

  if (running) {
    // Verify via IPC
    try {
      const client = new CoogleClient(socketPath);
      const status = await client.status();
      const s = status as { connected?: boolean; childRunning?: boolean; uptime?: number };
      ok(`Daemon running (uptime: ${s.uptime ?? 0}s)`);
    } catch {
      warn("Socket exists but IPC status check failed — may still be starting");
    }
  } else {
    warn("Daemon socket not detected yet — check logs at /tmp/coogle.log");
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 7: Update Claude Code config
// ---------------------------------------------------------------------------

async function stepUpdateClaudeConfig(indexJsPath: string): Promise<boolean> {
  header("Step 7: Update Claude Code Config");

  const claudeJsonPath = join(homedir(), ".claude.json");
  const backupPath = join(homedir(), ".claude.json.backup");

  if (!existsSync(claudeJsonPath)) {
    warn("~/.claude.json not found — skipping Claude config update");
    return false;
  }

  // Parse current config
  let parsed: Record<string, unknown>;
  try {
    const raw = readFileSync(claudeJsonPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    warn(`Could not parse ~/.claude.json: ${err}`);
    return false;
  }

  const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;

  // Find the coogle server and show current config
  if (mcpServers) {
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      const srvCfg = serverConfig as Record<string, unknown>;
      const hasGoogleCreds =
        (srvCfg["env"] as Record<string, string> | undefined)?.[
          "GOOGLE_OAUTH_CLIENT_ID"
        ];
      if (hasGoogleCreds || serverName === "coogle" || serverName === "workspace") {
        const currentCmd = srvCfg["command"] as string | undefined;
        const currentArgs = (srvCfg["args"] as string[] | undefined) ?? [];
        info(`Server name: ${cyan(serverName)}`);
        info(
          `Current:     ${cyan([currentCmd ?? "(none)", ...currentArgs].join(" "))}`
        );
      }
    }
  }

  info(`New:         ${cyan(`node ${indexJsPath} mcp`)}`);
  info(`Backup will be saved to: ${cyan(backupPath)}`);
  process.stdout.write("\n");

  const doUpdate = await promptYesNo(
    "Update ~/.claude.json to use coogle shim?",
    true
  );

  if (!doUpdate) {
    warn("Skipping Claude config update");
    return false;
  }

  // Backup
  try {
    copyFileSync(claudeJsonPath, backupPath);
    ok(`Backup saved: ${cyan(backupPath)}`);
  } catch (err) {
    throw new Error(`Failed to backup ~/.claude.json: ${err}`);
  }

  // Find the server key to update: "coogle", or "workspace" (legacy), or first with Google creds
  let targetServerName: string | null = null;
  if (mcpServers) {
    // Priority 1: existing "coogle" key
    if (mcpServers["coogle"]) {
      targetServerName = "coogle";
    }
    // Priority 2: legacy "workspace" key (will be renamed to "coogle")
    if (!targetServerName && mcpServers["workspace"]) {
      targetServerName = "workspace";
    }
    // Priority 3: any server with Google OAuth creds
    if (!targetServerName) {
      for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
        const srvCfg = serverConfig as Record<string, unknown>;
        const env = srvCfg["env"] as Record<string, string> | undefined;
        if (env?.["GOOGLE_OAUTH_CLIENT_ID"]) {
          targetServerName = serverName;
          break;
        }
      }
    }
  }

  if (!targetServerName) {
    warn("No suitable mcpServers entry found — creating new 'coogle' entry");
    targetServerName = "coogle";
  }

  // Build the new servers block
  const newServersBlock = { ...(mcpServers ?? {}) };

  // If migrating from "workspace" key, remove the old key and use "coogle"
  if (targetServerName === "workspace") {
    info(`Migrating server key: ${cyan('"workspace"')} → ${cyan('"coogle"')}`);
    delete newServersBlock["workspace"];
    targetServerName = "coogle";
  }

  // Set the coogle shim entry
  newServersBlock[targetServerName] = {
    type: "stdio",
    command: "node",
    args: [indexJsPath, "mcp"],
  };

  parsed["mcpServers"] = newServersBlock;

  try {
    writeFileSync(claudeJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    ok(`Updated ${cyan("~/.claude.json")} — server "${targetServerName}" now uses coogle shim`);
    warn("Restart Claude Code to apply the new MCP config");
  } catch (err) {
    throw new Error(`Failed to write ~/.claude.json: ${err}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 8: Done summary
// ---------------------------------------------------------------------------

async function stepDone(opts: {
  socketPath: string;
  toolCount: number;
  launchdInstalled: boolean;
  claudeConfigUpdated: boolean;
  indexJsPath: string;
}): Promise<void> {
  header("Setup Complete!");

  const { socketPath, toolCount, launchdInstalled, claudeConfigUpdated, indexJsPath } = opts;

  process.stdout.write("\n");

  if (launchdInstalled) {
    // Check daemon status one more time
    let pid = "";
    let uptime = "";
    try {
      const client = new CoogleClient(socketPath);
      const status = await client.status();
      const s = status as { uptime?: number };
      uptime = `${s.uptime ?? 0}s`;
    } catch {
      // ignore
    }

    ok(`Daemon: ${launchdInstalled ? "running via launchd" + (pid ? ` (PID: ${pid})` : "") : "not installed"}`);
    if (uptime) ok(`Uptime: ${uptime}`);
  } else {
    info("Daemon: not installed as launchd service");
    info(`Start manually: ${cyan(`node ${indexJsPath} serve`)}`);
  }

  if (toolCount > 0) {
    ok(`Tools: ${toolCount} available`);
  }

  if (claudeConfigUpdated) {
    ok("Claude Code config updated — restart Claude Code to apply");
  }

  process.stdout.write("\n");
  process.stdout.write(bold("  Commands:\n"));
  process.stdout.write(`    ${cyan(`node ${indexJsPath} status`)}    — Check daemon status\n`);
  process.stdout.write(`    ${cyan(`node ${indexJsPath} restart`)}   — Restart coogle-mcp child\n`);

  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.pai.coogle.plist");
  if (launchdInstalled) {
    process.stdout.write(
      `    ${cyan(`launchctl unload ${plistPath}`)} — Stop launchd service\n`
    );
  }

  if (claudeConfigUpdated) {
    process.stdout.write("\n");
    process.stdout.write(bold("  Rollback:\n"));
    process.stdout.write(
      `    ${cyan(`cp ~/.claude.json.backup ~/.claude.json`)}  — Restore original Claude config\n`
    );
  }

  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a command and return a promise that resolves when it exits successfully
 * or rejects with stderr on non-zero exit.
 */
function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      }
    });
    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Plist generator (mirrors logic in index.ts generatePlist)
// ---------------------------------------------------------------------------

function generatePlist(indexJsPath: string, socketPath: string): string {
  const nodePath = process.execPath;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pai.coogle</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${indexJsPath}</string>
    <string>serve</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/coogle.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/coogle.log</string>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write(bold("coogle setup") + "\n");
  process.stdout.write("=============\n");
  process.stdout.write(
    dim("Interactive first-time setup. Press Ctrl+C at any time to abort.\n")
  );

  const socketPath = "/tmp/coogle.sock";

  try {
    // Step 1: Environment
    const env = await stepEnvironment();

    // Step 2: Credentials
    const creds = await stepCredentials();

    // Step 3: Write config
    await stepWriteConfig(env, creds, socketPath);

    // Step 4: Build check
    const indexJsPath = await stepBuildCheck();

    // Step 5: Test daemon
    let toolCount = 0;
    try {
      const result = await stepTestDaemon(indexJsPath, socketPath);
      toolCount = result.toolCount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Daemon test failed: ${msg}`);
      warn("You may still continue — the daemon test is non-fatal.");
      const doContinue = await promptYesNo("Continue with setup anyway?", true);
      if (!doContinue) {
        throw new Error("Setup aborted by user after daemon test failure.");
      }
    }

    // Step 6: launchd (macOS only)
    let launchdInstalled = false;
    if (env.isMacOS) {
      try {
        launchdInstalled = await stepInstallLaunchd(indexJsPath, socketPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`launchd installation failed: ${msg}`);
        warn("You can install it manually later with: node dist/index.js generate-plist");
      }
    } else {
      header("Step 6: Install launchd Service");
      warn("Not macOS — skipping launchd installation");
    }

    // Step 7: Update Claude config
    let claudeConfigUpdated = false;
    try {
      claudeConfigUpdated = await stepUpdateClaudeConfig(indexJsPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Claude config update failed: ${msg}`);
    }

    // Step 8: Done
    await stepDone({
      socketPath,
      toolCount,
      launchdInstalled,
      claudeConfigUpdated,
      indexJsPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n${red("Setup failed:")} ${msg}\n`);
    process.exit(1);
  } finally {
    closeReadline();
  }
}
