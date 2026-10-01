import { createServer, type Server } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";

import type { CodexTurnBridge } from "./bridge.js";
import { handleModernMcpRequest } from "./mcp/modern.js";
import type { ProjectedNativeTool } from "./mcp/projected-tools.js";
import type { NativeSkillTools } from "./mcp/skill-tools.js";
import { handleProviderHttpRequest } from "./provider/http.js";
import type { ExecToolSpec } from "./provider/protocol.js";

export interface SidebandHttpSurfaceOptions {
  bridge: CodexTurnBridge;
  host?: string;
  port?: number;
}

export class SidebandHttpSurface {
  readonly #bridge: CodexTurnBridge;
  readonly #host: string;
  readonly #requestedPort: number;
  #server?: Server;
  #mcpServer?: McpServer;
  #execSpec?: ExecToolSpec;
  #projectedTools: ProjectedNativeTool[] = [];
  #nativeSkillTools?: NativeSkillTools;
  #port?: number;

  constructor(options: SidebandHttpSurfaceOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host ?? "127.0.0.1";
    if (!isLoopbackHost(this.#host)) {
      throw new Error(`Sideband only binds loopback addresses; received host ${this.#host}`);
    }
    this.#requestedPort = options.port ?? 0;
  }

  get providerBaseUrl(): string {
    return `${this.origin}/v1`;
  }

  get mcpUrl(): string {
    return `${this.origin}/mcp`;
  }

  get origin(): string {
    if (this.#port === undefined) throw new Error("Sideband HTTP surface is not started");
    return `http://${formatHostForUrl(this.#host)}:${this.#port}`;
  }

  setMcpServer(
    server: McpServer,
    execSpec: ExecToolSpec,
    projectedTools: ProjectedNativeTool[] = [],
    nativeSkillTools?: NativeSkillTools,
  ): void {
    this.#mcpServer = server;
    this.#execSpec = execSpec;
    this.#projectedTools = projectedTools;
    this.#nativeSkillTools = nativeSkillTools;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Sideband HTTP surface is already started");

    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    const server = createServer(async (req, res) => {
      try {
        if (!validateHost(req, res) || !validateOrigin(req, res)) return;
        if (await handleProviderHttpRequest(req, res, this.#bridge)) return;

        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        if (url.pathname !== "/mcp") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }

        if (!this.#mcpServer || !this.#execSpec) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Codex tool surface is not ready" }));
          return;
        }

        if (
          await handleModernMcpRequest(req, res, {
            bridge: this.#bridge,
            execSpec: this.#execSpec,
            projectedTools: this.#projectedTools,
            nativeSkillTools: this.#nativeSkillTools,
          })
        ) {
          return;
        }

        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await this.#mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: errorMessage(error) }));
        } else if (!res.writableEnded) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    server.requestTimeout = 0;
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#requestedPort, this.#host);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Could not determine Sideband listening address");
    }
    this.#port = address.port;
  }

  async close(): Promise<void> {
    const mcpServer = this.#mcpServer;
    this.#mcpServer = undefined;
    this.#execSpec = undefined;
    this.#projectedTools = [];
    this.#nativeSkillTools = undefined;
    if (mcpServer) await mcpServer.close();

    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    if (!server) return;

    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  }
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
