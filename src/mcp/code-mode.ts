import type {BridgeCallOptions, CodexTurnBridge} from "../bridge.js";
import {cleanCodeModeResult, type BridgeCallResult} from "../provider/protocol.js";
import {runBridgeTask} from "./bridge-scheduler.js";

/** Keep the native call attached until its reply, then drain or terminate its cell.
 * Cancelling an MCP request cannot interrupt a native tool already executing.
 * A yielded Code Mode cell can be terminated at the next native reply.
 */
export async function invokeExecAndWait(
  bridge: CodexTurnBridge,
  code: string,
  options: BridgeCallOptions = {},
): Promise<BridgeCallResult> {
  return runBridgeTask(bridge, signal => drainExec(bridge, code, signal), options);
}

async function drainExec(bridge: CodexTurnBridge, code: string, signal: AbortSignal): Promise<BridgeCallResult> {
  signal.throwIfAborted();
  let result = await bridge.invokeExec(code);
  const content: BridgeCallResult["content"] = [];
  let isError = false;
  while (true) {
    const cellId = yieldedCellId(result);
    if (signal.aborted) {
      if (cellId) await bridge.invokeFunction("functions", "wait", {cell_id: cellId, terminate: true});
      signal.throwIfAborted();
    }
    isError ||= result.isError;
    if (!cellId) {
      content.push(...cleanCodeModeResult(result).content);
      return {content, isError};
    }
    if (!bridge.hasFunctionTool("wait")) {
      throw new Error(`Codex yielded cell ${cellId}, but its native functions.wait is unavailable`);
    }
    content.push(...result.content.filter(item => item.type !== "text" || !/^Script running with cell ID\s+\S+/.test(item.text.trim())));
    result = await bridge.invokeFunction("functions", "wait", {cell_id: cellId, yield_time_ms: 10_000});
  }
}

function yieldedCellId(result: BridgeCallResult): string | undefined {
  for (const item of result.content) {
    if (item.type !== "text") continue;
    const match = item.text.trim().match(/^Script running with cell ID\s+([^\s]+)/);
    if (match) return match[1];
  }
  return undefined;
}
