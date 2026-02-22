/**
 * config.ts — Configuration loader for coogle
 *
 * Loads config from ~/.config/coogle/config.json (XDG convention).
 * Deep-merges with defaults so partial configs work fine.
 * Expands ~ in path values at runtime.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoogleConfig {
  /** Unix Domain Socket path for IPC */
  socketPath: string;

  /** coogle-mcp command and arguments */
  mcp: {
    command: string;
    args: string[];
  };

  /** Where to find Google OAuth credentials */
  credentials: {
    source: "claude-json" | "env" | "manual";
    claudeJsonPath?: string;
    mcpServerName?: string;
    clientId?: string;
    clientSecret?: string;
  };

  /** Timeout for coogle-mcp tool calls (milliseconds) */
  callTimeoutMs: number;

  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: CoogleConfig = {
  socketPath: "/tmp/coogle.sock",
  mcp: {
    command: "uvx",
    args: ["coogle-mcp", "--tool-tier", "core"],
  },
  credentials: {
    source: "claude-json",
    claudeJsonPath: "~/.claude.json",
    mcpServerName: "coogle",
  },
  callTimeoutMs: 120_000,
  logLevel: "info",
};

// Template written to config.json on first `serve` run
const CONFIG_TEMPLATE = `{
  "socketPath": "/tmp/coogle.sock",
  "mcp": {
    "command": "uvx",
    "args": ["coogle-mcp", "--tool-tier", "core"]
  },
  "credentials": {
    "source": "claude-json",
    "claudeJsonPath": "~/.claude.json",
    "mcpServerName": "coogle"
  },
  "callTimeoutMs": 120000,
  "logLevel": "info"
}
`;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand a leading ~ to the real home directory */
export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export const CONFIG_DIR = join(homedir(), ".config", "coogle");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Deep merge (handles nested objects, not arrays)
// ---------------------------------------------------------------------------

function deepMerge<T extends object>(target: T, source: Record<string, unknown>): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    const tgtVal = (target as Record<string, unknown>)[key];
    if (
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as object,
        srcVal as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load configuration from ~/.config/coogle/config.json.
 * Returns defaults merged with any values found in the file.
 */
export function loadConfig(): CoogleConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[coogle] Could not read config file at ${CONFIG_FILE}: ${err}\n`
    );
    return { ...DEFAULTS };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(
      `[coogle] Config file is not valid JSON: ${err}\n`
    );
    return { ...DEFAULTS };
  }

  return deepMerge(DEFAULTS, parsed);
}

/**
 * Ensure ~/.config/coogle/ exists and write a default config.json
 * template if none exists yet. Call this only from the `serve` command.
 */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    process.stderr.write(
      `[coogle] Created config directory: ${CONFIG_DIR}\n`
    );
  }

  if (!existsSync(CONFIG_FILE)) {
    try {
      writeFileSync(CONFIG_FILE, CONFIG_TEMPLATE, "utf-8");
      process.stderr.write(
        `[coogle] Wrote default config to: ${CONFIG_FILE}\n`
      );
    } catch (err) {
      process.stderr.write(
        `[coogle] Could not write default config: ${err}\n`
      );
    }
  }
}
