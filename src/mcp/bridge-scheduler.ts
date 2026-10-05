import type {BridgeCallOptions, CodexTurnBridge} from "../bridge.js";
import {createKeyedTaskScheduler, type KeyedTaskScheduler} from "../keyed-task-scheduler.js";
import type {BridgeCallResult} from "../provider/protocol.js";

const schedulers = new WeakMap<CodexTurnBridge, KeyedTaskScheduler>();

/** Cancellation releases the caller immediately, but reserves the native turn
 * until its reply has been drained. Inventory refreshes share this same queue.
 */
export function runBridgeTask<T>(
  bridge: CodexTurnBridge,
  task: (signal: AbortSignal) => Promise<T>,
  options: BridgeCallOptions = {},
): Promise<T> {
  let scheduler = schedulers.get(bridge);
  if (!scheduler) {
    scheduler = createKeyedTaskScheduler({concurrency: 1});
    schedulers.set(bridge, scheduler);
  }
  return scheduler.enqueue({key: bridge, task, signal: options.signal}).catch(error => {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw error;
  });
}

export function invokeQueuedFunction(
  bridge: CodexTurnBridge,
  namespace: string,
  name: string,
  args: Record<string, unknown>,
  options: BridgeCallOptions = {},
): Promise<BridgeCallResult> {
  return runBridgeTask(bridge, async signal => {
    signal.throwIfAborted();
    const result = await bridge.invokeFunction(namespace, name, args);
    signal.throwIfAborted();
    return result;
  }, options);
}
