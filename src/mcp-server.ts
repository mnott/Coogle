/**
 * mcp-server.ts — The MCP shim (thin proxy for Claude)
 *
 * This is the MCP shim that Claude Code runs. It:
 *   1. Connects to the daemon via IPC on startup
 *   2. Discovers all available tools from the daemon (dynamic — no hardcoding)
 *   3. Registers tools/list and tools/call handlers with the low-level Server
 *   4. Forwards every tool call to the daemon via IPC
 *   5. Returns results back to Claude
 *
 * Uses the low-level Server class (not McpServer) so we can return the exact
 * tool definitions from coogle-mcp without any JSON Schema conversion.
 *
 * CRITICAL: stdout is the MCP JSON-RPC transport.
 *   - NEVER write non-JSON to stdout.
 *   - All debug output goes to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CoogleClient, ToolDefinition } from "./ipc-client.js";
import { CoogleConfig } from "./config.js";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to list tools from the daemon, retrying on failure.
 */
async function listToolsWithRetry(
  client: CoogleClient
): Promise<ToolDefinition[]> {
  let lastErr: Error = new Error("unknown");

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const tools = await client.listTools();
      return tools;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(
        `[coogle-shim] Failed to list tools (attempt ${attempt}/${RETRY_COUNT}): ${lastErr.message}\n`
      );
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(
    `coogle daemon not reachable after ${RETRY_COUNT} attempts: ${lastErr.message}\n` +
      `Start the daemon with: node dist/index.js serve`
  );
}

/**
 * Start the MCP shim.
 */
export async function runMcpServer(config: CoogleConfig): Promise<void> {
  process.stderr.write("[coogle-shim] Starting MCP shim...\n");

  const daemonClient = new CoogleClient(config.socketPath);

  // Discover tools from the daemon
  let tools: ToolDefinition[];
  try {
    tools = await listToolsWithRetry(daemonClient);
  } catch (err) {
    process.stderr.write(`[coogle-shim] FATAL: ${err}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `[coogle-shim] Discovered ${tools.length} tools from daemon.\n`
  );

  // Build a name→definition map for fast lookup in CallTool handler
  const toolMap = new Map<string, ToolDefinition>(
    tools.map((t) => [t.name, t])
  );

  // Use the low-level Server class so we can pass inputSchema as-is
  const server = new Server(
    { name: "coogle", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // tools/list — return exact tool definitions from coogle-mcp
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || `${t.name} tool`,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // tools/call — proxy to daemon via IPC
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!toolMap.has(name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: Unknown tool "${name}"`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await daemonClient.call(name, (args ?? {}) as Record<string, unknown>);

      // The result from coogle-mcp is already a CallToolResult object
      // with { content: [...], isError?: boolean }. Return it directly.
      if (
        result !== null &&
        typeof result === "object" &&
        "content" in (result as Record<string, unknown>)
      ) {
        return result as { content: { type: string; text: string }[]; isError?: boolean };
      }

      // Fallback: wrap plain result as text content
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  });

  process.stderr.write(
    `[coogle-shim] Registered ${tools.length} tools via direct handlers.\n`
  );

  // Start the MCP server over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[coogle-shim] MCP shim running.\n");
}
