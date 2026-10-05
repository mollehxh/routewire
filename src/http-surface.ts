import { createServer, type Server } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";

import type { CodexBridgeEvent, CodexTurnBridge } from "./bridge.js";
import type { CollaborationTool } from "./mcp/collaboration-tools.js";
import { handleModernMcpRequest } from "./mcp/modern.js";
import type { ProjectedNativeTool } from "./mcp/projected-tools.js";
import type { NativeSkillTools } from "./mcp/skill-tools.js";
import { handleProviderHttpRequest } from "./provider/http.js";
import type { ExecToolSpec } from "./provider/protocol.js";
import type { ReasoningEffort } from "./model-catalog.js";

export interface RunwireHttpSurfaceOptions {
  bridge: CodexTurnBridge;
  host?: string;
  port?: number;
  allowedSubagentModels?: readonly string[];
  subagentModelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  onEvent?: (event: CodexBridgeEvent) => void;
}

export class RunwireHttpSurface {
  readonly #bridge: CodexTurnBridge;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #allowedSubagentModels: readonly string[];
  readonly #subagentModelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  readonly #onEvent?: (event: CodexBridgeEvent) => void;
  #server?: Server;
  #mcpServer?: McpServer;
  #execSpec?: ExecToolSpec;
  #projectedTools: ProjectedNativeTool[] = [];
  #nativeSkillTools?: NativeSkillTools;
  #collaborationTools: CollaborationTool[] = [];
  #port?: number;
  #refreshProjectedTools?: () => Promise<ProjectedNativeTool[]>;
  #closePromise?: Promise<void>;

  constructor(options: RunwireHttpSurfaceOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host ?? "127.0.0.1";
    if (!isLoopbackHost(this.#host)) {
      throw new Error(`Runwire only binds loopback addresses; received host ${this.#host}`);
    }
    this.#requestedPort = options.port ?? 0;
    this.#allowedSubagentModels = options.allowedSubagentModels ?? ["gpt-6-luna"];
    this.#subagentModelEfforts = options.subagentModelEfforts;
    this.#onEvent = options.onEvent;
  }

  get providerBaseUrl(): string {
    return `${this.origin}/v1`;
  }

  get mcpUrl(): string {
    return `${this.origin}/mcp`;
  }

  get origin(): string {
    if (this.#port === undefined) throw new Error("Runwire HTTP surface is not started");
    return `http://${formatHostForUrl(this.#host)}:${this.#port}`;
  }

  setMcpServer(
    server: McpServer,
    execSpec: ExecToolSpec,
    projectedTools: ProjectedNativeTool[] = [],
    nativeSkillTools?: NativeSkillTools,
    collaborationTools: CollaborationTool[] = [],
    refreshProjectedTools?: () => Promise<ProjectedNativeTool[]>,
  ): void {
    this.#mcpServer = server;
    this.#execSpec = execSpec;
    this.#projectedTools = projectedTools;
    this.#nativeSkillTools = nativeSkillTools;
    this.#collaborationTools = collaborationTools;
    this.#refreshProjectedTools = refreshProjectedTools;
  }

  updateProjectedTools(tools: ProjectedNativeTool[]): void {
    this.#projectedTools = tools;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Runwire HTTP surface is already started");
    if (this.#closePromise) {
      await this.#closePromise.catch(() => undefined);
      this.#closePromise = undefined;
    }

    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    const server = createServer(async (req, res) => {
      try {
        if (!validateHost(req, res) || !validateOrigin(req, res)) return;
        if (await handleProviderHttpRequest(req, res, this.#bridge, {
          allowedModels: this.#allowedSubagentModels,
          modelEfforts: this.#subagentModelEfforts,
        })) return;

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
            collaborationTools: this.#collaborationTools,
            onEvent: this.#onEvent,
            refreshProjectedTools: this.#refreshProjectedTools,
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
      throw new Error("Could not determine Runwire listening address");
    }
    this.#port = address.port;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const mcpServer = this.#mcpServer;
    this.#mcpServer = undefined;
    this.#execSpec = undefined;
    this.#projectedTools = [];
    this.#nativeSkillTools = undefined;
    this.#collaborationTools = [];
    this.#refreshProjectedTools = undefined;

    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    const closeHttp = server ? new Promise<void>(resolve => {
      // Stop accepting connections immediately, then bound incomplete requests.
      const grace = setTimeout(() => server.closeAllConnections(), 250);
      grace.unref();
      server.close(() => {
        clearTimeout(grace);
        resolve();
      });
      server.closeIdleConnections();
    }) : Promise.resolve();

    this.#closePromise = Promise.allSettled([
      closeHttp,
      Promise.resolve().then(() => mcpServer?.close()),
    ]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    return this.#closePromise;
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
