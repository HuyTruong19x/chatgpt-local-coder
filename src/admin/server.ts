import type { Server } from "node:http";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";

export interface AdminServerOptions {
  host?: string;
  port: number;
  mcpPort: number;
  pid: number;
  manager: McpUpstreamManager;
  sessionCount: () => number;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}

/** Legacy entry point retained to report a clear migration error. */
export function startAdminServer(_options: AdminServerOptions): Server {
  throw new Error("Admin HTTP is owned by the password-protected controller. Run npm start or launcher.cmd; runtime admin handlers now use Node IPC.");
}
