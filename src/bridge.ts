import { createHash } from "node:crypto";

import {
  extractCodexOperationalContext,
  type CodexOperationalContext,
} from "./provider/context.js";
import {
  bridgeResultFromCodexOutput,
  extractAgentMessages,
  extractCustomToolCallOutput,
  extractExecToolSpec,
  extractFunctionCallOutput,
  extractFunctionToolSpecs,
  isRecord,
  type BridgeCallResult,
  type ExecToolSpec,
  type FunctionToolSpec,
  type ProviderReply,
} from "./provider/protocol.js";

export interface CodexTurnBridgeOptions {
  model: string;
}

type ProviderResponder = (reply: ProviderReply) => void;

interface ActiveCall {
  callId: string;
  requestFingerprint: string;
  providerReply: Extract<ProviderReply, { kind: "tool_call" }>;
  resolve: (result: BridgeCallResult) => void;
  reject: (error: Error) => void;
}

export class CodexTurnBridge {
  readonly #model: string;
  #execSpec?: ExecToolSpec;
  #collaborationTools: FunctionToolSpec[] = [];
  #readyPromise: Promise<ExecToolSpec>;
  #resolveReady!: (spec: ExecToolSpec) => void;
  #rejectReady!: (error: Error) => void;
  #pendingModelReply?: ProviderResponder;
  #pendingModelRequestFingerprint?: string;
  #activeCall?: ActiveCall;
  #operationalContext?: CodexOperationalContext;
  #seenAgentMessages = new Set<string>();
  #callCounter = 0;
  #closed = false;

  constructor(options: CodexTurnBridgeOptions) {
    this.#model = options.model;
    this.#readyPromise = new Promise<ExecToolSpec>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  get model(): string {
    return this.#model;
  }

  ready(): Promise<ExecToolSpec> {
    return this.#readyPromise;
  }

  operationalContext(): CodexOperationalContext {
    if (!this.#operationalContext) {
      throw new Error("Codex operational context is not available yet");
    }
    return structuredClone(this.#operationalContext);
  }

  collaborationTools(): FunctionToolSpec[] {
    return structuredClone(this.#collaborationTools);
  }

  acceptModelRequest(body: unknown, respond: ProviderResponder): void {
    if (this.#closed) throw new Error("Sideband bridge is closed");
    if (!isRecord(body)) throw new Error("Codex provider request must be an object");
    if (body.model !== this.#model) {
      const error = new Error(`Expected Codex model ${this.#model}, received ${String(body.model)}`);
      if (!this.#execSpec) this.#rejectReady(error);
      throw error;
    }

    const spec = extractExecToolSpec(body);
    const collaborationTools = extractFunctionToolSpecs(body, "collaboration");
    if (collaborationTools.length > 0) this.#collaborationTools = collaborationTools;
    if (spec && !this.#execSpec) {
      this.#execSpec = spec;
      this.#resolveReady(spec);
    }

    const operationalContext = extractCodexOperationalContext(body, this.#model);
    if (operationalContext) {
      this.#operationalContext = this.#operationalContext
        ? {
            model: operationalContext.model,
            environment: operationalContext.environment ?? this.#operationalContext.environment,
            permissions: operationalContext.permissions ?? this.#operationalContext.permissions,
            projectInstructions:
              operationalContext.projectInstructions.length > 0
                ? operationalContext.projectInstructions
                : this.#operationalContext.projectInstructions,
          }
        : operationalContext;
    }

    const requestFingerprint = modelRequestFingerprint(body);

    if (this.#pendingModelReply) {
      if (requestFingerprint === this.#pendingModelRequestFingerprint) {
        // Codex reconnects and retries the same Responses request if the SSE
        // stream disappears while Sideband is waiting for ChatGPT's next MCP
        // call. Rebind the pending reply to the newest stream instead of
        // treating the retry as a concurrent model request.
        this.#pendingModelReply = respond;
        return;
      }
      throw new Error("Codex opened a second model request before Sideband answered the first");
    }

    if (this.#activeCall) {
      if (requestFingerprint === this.#activeCall.requestFingerprint) {
        // The previous stream may have disappeared after Sideband emitted the
        // tool call but before Codex accepted the completed response. Replay
        // the exact same call id/input on the retried request so the bridge
        // remains idempotent from Codex's point of view.
        respond(this.#activeCall.providerReply);
        return;
      }

      const output =
        this.#activeCall.providerReply.callType === "custom"
          ? extractCustomToolCallOutput(body, this.#activeCall.callId)
          : extractFunctionCallOutput(body, this.#activeCall.callId);
      if (output === undefined) {
        throw new Error(
          `Codex provider request did not contain output for active call ${this.#activeCall.callId}`,
        );
      }

      const activeCall = this.#activeCall;
      this.#activeCall = undefined;
      const result = bridgeResultFromCodexOutput(output);
      result.content.push(
        ...extractAgentMessages(body).flatMap(message => {
          const key = message.id ?? `text:${message.text}`;
          if (this.#seenAgentMessages.has(key)) return [];
          this.#seenAgentMessages.add(key);
          return [{ type: "text" as const, text: message.text }];
        }),
      );
      activeCall.resolve(result);
    }

    this.#pendingModelReply = respond;
    this.#pendingModelRequestFingerprint = requestFingerprint;
  }

  invokeExec(code: string): Promise<BridgeCallResult> {
    if (this.#closed) return Promise.reject(new Error("Sideband bridge is closed"));
    if (!this.#execSpec) return Promise.reject(new Error("Codex tool surface is not ready yet"));
    if (this.#activeCall) return Promise.reject(new Error("A Codex tool call is already active"));
    if (!this.#pendingModelReply) {
      return Promise.reject(new Error("Codex is not currently waiting for a model response"));
    }

    const callId = `sideband-${++this.#callCounter}`;
    const respond = this.#pendingModelReply;
    const requestFingerprint = this.#pendingModelRequestFingerprint;
    this.#pendingModelReply = undefined;
    this.#pendingModelRequestFingerprint = undefined;
    if (!requestFingerprint) {
      return Promise.reject(new Error("Codex pending model request fingerprint is missing"));
    }

    const providerReply: Extract<ProviderReply, { kind: "tool_call" }> = {
      kind: "tool_call",
      callType: "custom",
      callId,
      namespace: "functions",
      name: "exec",
      input: code,
      arguments: "",
    };

    return new Promise<BridgeCallResult>((resolve, reject) => {
      this.#activeCall = {
        callId,
        requestFingerprint,
        providerReply,
        resolve,
        reject,
      };

      try {
        respond(providerReply);
      } catch (error) {
        this.#activeCall = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  invokeFunction(
    namespace: string,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<BridgeCallResult> {
    if (this.#closed) return Promise.reject(new Error("Sideband bridge is closed"));
    if (this.#activeCall) return Promise.reject(new Error("A Codex tool call is already active"));
    if (!this.#pendingModelReply) {
      return Promise.reject(new Error("Codex is not currently waiting for a model response"));
    }
    if (
      namespace === "collaboration" &&
      !this.#collaborationTools.some(tool => tool.name === name)
    ) {
      return Promise.reject(new Error(`Codex collaboration tool is not available: ${name}`));
    }

    const callId = `sideband-${++this.#callCounter}`;
    const respond = this.#pendingModelReply;
    const requestFingerprint = this.#pendingModelRequestFingerprint;
    this.#pendingModelReply = undefined;
    this.#pendingModelRequestFingerprint = undefined;
    if (!requestFingerprint) {
      return Promise.reject(new Error("Codex pending model request fingerprint is missing"));
    }

    const providerReply: Extract<ProviderReply, { kind: "tool_call" }> = {
      kind: "tool_call",
      callType: "function",
      callId,
      namespace,
      name,
      input: "",
      arguments: JSON.stringify(arguments_),
    };

    return new Promise<BridgeCallResult>((resolve, reject) => {
      this.#activeCall = {
        callId,
        requestFingerprint,
        providerReply,
        resolve,
        reject,
      };

      try {
        respond(providerReply);
      } catch (error) {
        this.#activeCall = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(reason = "Sideband bridge closed"): void {
    if (this.#closed) return;
    this.#closed = true;

    if (!this.#execSpec) this.#rejectReady(new Error(reason));
    if (this.#activeCall) {
      this.#activeCall.reject(new Error(reason));
      this.#activeCall = undefined;
    }

    const respond = this.#pendingModelReply;
    this.#pendingModelReply = undefined;
    this.#pendingModelRequestFingerprint = undefined;
    if (respond) respond({ kind: "complete", text: reason });
  }
}

function modelRequestFingerprint(body: Record<string, unknown>): string {
  // client_metadata contains transport/session metadata that can legitimately
  // change across retries without changing the model-visible request. The
  // remaining request body identifies the logical Responses request.
  const semanticBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "client_metadata"),
  );
  return createHash("sha256").update(stableStringify(semanticBody)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
