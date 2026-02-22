/**
 * ipc-client.ts — IPC client for the MCP shim
 *
 * CoogleClient connects to the Unix Domain Socket served by daemon.ts
 * and forwards tool calls to the daemon. Uses fresh socket connection per call
 * (connect → write JSON + newline → read response line → parse → destroy).
 * This keeps the client stateless and avoids connection management complexity.
 *
 * Adapted from Whazaa's WatcherClient pattern.
 */

import { connect, Socket } from "node:net";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/** Default socket path — used when no config is available */
export const IPC_SOCKET_PATH = "/tmp/coogle.sock";

/** Timeout for IPC calls (60 seconds) */
const IPC_TIMEOUT_MS = 60_000;

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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Thin IPC proxy that forwards tool calls to coogle over a Unix
 * Domain Socket. Each call opens a fresh connection, sends one NDJSON request,
 * reads the response, and closes. Stateless and simple.
 *
 * @param socketPath - Optional socket path override. Defaults to IPC_SOCKET_PATH.
 */
export class CoogleClient {
  private readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? IPC_SOCKET_PATH;
  }

  /**
   * Call a coogle-mcp tool by name with the given params.
   * Returns the tool result or throws on error.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params);
  }

  /**
   * List all tools available from the coogle-mcp child.
   * Calls the special "list_tools" IPC method on the daemon.
   */
  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.send("list_tools", {});
    return result as ToolDefinition[];
  }

  /**
   * Check daemon status.
   */
  async status(): Promise<Record<string, unknown>> {
    const result = await this.send("status", {});
    return result as Record<string, unknown>;
  }

  /**
   * Restart the coogle-mcp child process.
   */
  async restartChild(): Promise<void> {
    await this.send("restart_child", {});
  }

  // -------------------------------------------------------------------------
  // Internal transport
  // -------------------------------------------------------------------------

  /**
   * Send a single IPC request and wait for the response.
   * Opens a new socket connection per call — simple and reliable.
   */
  private send(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const socketPath = this.socketPath;

    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let done = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      function finish(err: Error | null, value?: unknown): void {
        if (done) return;
        done = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          socket?.destroy();
        } catch {
          // ignore
        }
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      }

      socket = connect(socketPath, () => {
        const request: IpcRequest = {
          id: randomUUID(),
          method,
          params,
        };
        socket!.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let response: IpcResponse;
        try {
          response = JSON.parse(line) as IpcResponse;
        } catch {
          finish(new Error(`IPC parse error: ${line}`));
          return;
        }

        if (!response.ok) {
          finish(new Error(response.error ?? "IPC call failed"));
        } else {
          finish(null, response.result);
        }
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          finish(
            new Error(
              "Coogle daemon not running. Start it with: node dist/index.js serve"
            )
          );
        } else {
          finish(err);
        }
      });

      socket.on("end", () => {
        if (!done) {
          finish(new Error("IPC connection closed before response"));
        }
      });

      timer = setTimeout(() => {
        finish(new Error("IPC call timed out after 60s"));
      }, IPC_TIMEOUT_MS);
    });
  }
}
