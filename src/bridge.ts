import {
  bridgeResultFromCodexOutput,
  extractCustomToolCallOutput,
  extractExecToolSpec,
  isRecord,
  type BridgeCallResult,
  type ExecToolSpec,
  type ProviderReply,
} from "./provider/protocol.js";

export interface CodexTurnBridgeOptions {
  model: string;
}

type ProviderResponder = (reply: ProviderReply) => void;

interface ActiveCall {
  callId: string;
  resolve: (result: BridgeCallResult) => void;
  reject: (error: Error) => void;
}

export class CodexTurnBridge {
  readonly #model: string;
  #execSpec?: ExecToolSpec;
  #readyPromise: Promise<ExecToolSpec>;
  #resolveReady!: (spec: ExecToolSpec) => void;
  #rejectReady!: (error: Error) => void;
  #pendingModelReply?: ProviderResponder;
  #activeCall?: ActiveCall;
  #callCounter = 0;
  #closed = false;

  constructor(options: CodexTurnBridgeOptions) {
    this.#model = options.model;
    this.#readyPromise = new Promise<ExecToolSpec>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  ready(): Promise<ExecToolSpec> {
    return this.#readyPromise;
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
    if (spec && !this.#execSpec) {
      this.#execSpec = spec;
      this.#resolveReady(spec);
    }

    if (this.#pendingModelReply) {
      throw new Error("Codex opened a second model request before Sideband answered the first");
    }

    if (this.#activeCall) {
      const output = extractCustomToolCallOutput(body, this.#activeCall.callId);
      if (output === undefined) {
        throw new Error(
          `Codex provider request did not contain output for active call ${this.#activeCall.callId}`,
        );
      }

      const activeCall = this.#activeCall;
      this.#activeCall = undefined;
      activeCall.resolve(bridgeResultFromCodexOutput(output));
    }

    this.#pendingModelReply = respond;
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
    this.#pendingModelReply = undefined;

    return new Promise<BridgeCallResult>((resolve, reject) => {
      this.#activeCall = { callId, resolve, reject };

      try {
        respond({
          kind: "tool_call",
          callId,
          namespace: "functions",
          name: "exec",
          input: code,
        });
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
    if (respond) respond({ kind: "complete", text: reason });
  }
}
