#!/usr/bin/env node
/**
 * index.ts — CLI entry point for coogle
 *
 * Usage: coogle <command>
 *
 * Commands:
 *   serve            Start the daemon (IPC server + coogle-mcp child)
 *   mcp              Start the MCP shim (thin proxy for Claude)
 *   status           Check daemon status
 *   restart          Restart the coogle-mcp child process
 *   config           Print the resolved configuration
 *   generate-plist   Generate the launchd plist for this system
 *   setup            Interactive first-time setup (zero to working)
 */

import { CoogleClient } from "./ipc-client.js";
import { serve } from "./daemon.js";
import { runMcpServer } from "./mcp-server.js";
import { loadConfig, CONFIG_FILE } from "./config.js";
import { runSetup } from "./setup.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];

// ---------------------------------------------------------------------------
// Plist generator
// ---------------------------------------------------------------------------

function generatePlist(): string {
  const nodePath = process.execPath;

  // Determine the dist/index.js path relative to this file.
  // In production: __dirname is dist/, so dist/index.js is in the same dir.
  // We resolve the project root as two levels up from dist/index.js.
  const __filename = fileURLToPath(import.meta.url);
  const distDir = dirname(__filename);
  const indexJsPath = join(distDir, "index.js");

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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (command) {
    case "serve": {
      const config = loadConfig();
      await serve(config);
      break;
    }

    case "mcp": {
      const config = loadConfig();
      await runMcpServer(config);
      break;
    }

    case "status": {
      const config = loadConfig();
      const client = new CoogleClient(config.socketPath);
      try {
        const status = await client.status();
        const s = status as {
          connected?: boolean;
          queueLength?: number;
          uptime?: number;
          childRunning?: boolean;
        };
        console.log("coogle status:");
        console.log(`  Child connected : ${s.connected ?? false}`);
        console.log(`  Child running   : ${s.childRunning ?? false}`);
        console.log(`  Queue length    : ${s.queueLength ?? 0}`);
        console.log(`  Uptime          : ${s.uptime ?? 0}s`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Could not reach daemon: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case "restart": {
      const config = loadConfig();
      const client = new CoogleClient(config.socketPath);
      try {
        await client.restartChild();
        console.log("coogle-mcp child restarted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to restart child: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case "config": {
      const config = loadConfig();
      console.log("coogle resolved config:");
      console.log(`  Config file : ${CONFIG_FILE}`);
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case "generate-plist": {
      const plist = generatePlist();
      const plistPath = join(
        homedir(),
        "Library",
        "LaunchAgents",
        "com.pai.coogle.plist"
      );
      process.stderr.write(
        [
          "# Install the launchd service:",
          `# 1. Save this output to ${plistPath}`,
          `#    node dist/index.js generate-plist > ${plistPath}`,
          `# 2. launchctl load ${plistPath}`,
          "# 3. To stop:  launchctl unload " + plistPath,
          "# 4. To restart: launchctl kickstart -k gui/$(id -u)/com.pai.coogle",
          "",
        ].join("\n")
      );
      process.stdout.write(plist);
      break;
    }

    case "setup": {
      await runSetup();
      break;
    }

    default: {
      console.error(
        [
          "Usage: coogle <command>",
          "",
          "Commands:",
          "  serve            Start the daemon (IPC server + coogle-mcp child)",
          "  mcp              Start the MCP shim (thin proxy for Claude)",
          "  status           Check daemon status",
          "  restart          Restart the coogle-mcp child process",
          "  config           Print the resolved configuration",
          "  generate-plist   Generate launchd plist for this system (stdout)",
          "  setup            Interactive first-time setup (zero to working)",
          "",
          "Config file: " + CONFIG_FILE,
        ].join("\n")
      );
      process.exit(command ? 1 : 0);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[coogle] Fatal error: ${err}\n`);
  process.exit(1);
});
