/**
 * A small, dependency free scheduler for tasks that must be serialized by key.
 *
 * Scheduling is event driven: enqueue, abort and task completion are the only
 * events that can make progress.  There is deliberately no timer or polling
 * loop.  Priority aging is calculated when one of those events occurs, so a
 * waiting task eventually wins over a stream of newer high priority tasks.
 */

export interface CreateKeyedTaskSchedulerOptions {
  /** Maximum number of task functions that may be running at once. */
  concurrency: number;
  /**
   * Number of milliseconds needed to add one priority point to a waiting
   * task.  The default is one second.  A smaller value gives fairness more
   * weight; a larger value preserves priority for longer.
   */
  agingMs?: number;
}

export interface EnqueueRequest<T, K = unknown> {
  key: K;
  /** Higher values are preferred at the same age. Defaults to zero. */
  priority?: number;
  task: (signal: AbortSignal) => T | PromiseLike<T>;
  signal?: AbortSignal;
}

export interface KeyedTaskScheduler<K = unknown> {
  enqueue<T>(request: EnqueueRequest<T, K>): Promise<T>;
  /**
   * Stop accepting new work. With drain=true, queued work is allowed to run;
   * with drain=false, queued and running work is cancelled. The returned
   * promise resolves once all running task functions have settled.
   */
  close(options: { drain: boolean }): Promise<void>;
}

/** Error used when enqueue is attempted after close(). */
export class SchedulerClosedError extends Error {
  constructor() {
    super("Task scheduler is closed");
    this.name = "SchedulerClosedError";
  }
}

/** Error used to reject a task that was cancelled by a signal or close(). */
export class TaskAbortError extends Error {
  readonly cause?: unknown;

  constructor(message = "Task aborted", cause?: unknown) {
    super(message);
    this.name = "AbortError";
    this.cause = cause;
  }
}

type TaskState = "queued" | "running" | "settled";

interface TaskRecord {
  readonly key: unknown;
  readonly task: (signal: AbortSignal) => unknown;
  readonly priority: number;
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly controller: AbortController;
  readonly externalSignal?: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;

  state: TaskState;
  settled: boolean;
  cancelled: boolean;
  externalAbortListener?: () => void;
}

interface KeyState {
  readonly queue: TaskRecord[];
  running: boolean;
}

/**
 * Creates an event-driven keyed task scheduler.
 *
 * Invariants:
 * - `active` is exactly the number of records in `running` state.
 * - A key has at most one running record.
 * - A record leaves its key queue exactly once and settles exactly once.
 * - `finish` is the only path that releases a running slot.
 * - Every cancellation path is idempotent and therefore safe against a
 *   completion/cancel/close race.
 */
export function createKeyedTaskScheduler<K = unknown>(
  options: CreateKeyedTaskSchedulerOptions,
): KeyedTaskScheduler<K> {
  if (!options || !Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }

  const agingMs = options.agingMs ?? 1_000;
  if (!Number.isFinite(agingMs) || agingMs <= 0) {
    throw new TypeError("agingMs must be a finite number greater than zero");
  }

  const keys = new Map<K, KeyState>();
  let active = 0;
  let sequence = 0;
  let closeState: "open" | "draining" | "closed" = "open";
  let scheduleInProgress = false;
  let scheduleAgain = false;
  let idleWaiters: Array<() => void> = [];
  // Running records are kept separately so close(false) can abort them while
  // each KeyState still tracks the per-key serialization invariant.
  const runningRecords = new Set<TaskRecord>();

  const isIdle = (): boolean => active === 0 && !hasQueuedWork();

  function hasQueuedWork(): boolean {
    for (const state of keys.values()) {
      if (state.queue.length > 0) return true;
    }
    return false;
  }

  function resolveIdleWaitersIfNeeded(): void {
    if (!isIdle() || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitForIdle(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  }

  function abortError(reason: unknown, fallbackMessage = "Task aborted"): TaskAbortError {
    if (reason instanceof TaskAbortError) return reason;
    if (reason instanceof Error && reason.name === "AbortError") {
      return new TaskAbortError(reason.message, reason);
    }
    return new TaskAbortError(fallbackMessage, reason);
  }

  function settleRecord(
    record: TaskRecord,
    error: unknown,
    value?: unknown,
    isError = true,
  ): void {
    if (record.settled) return;
    record.settled = true;
    if (isError) record.reject(error);
    else record.resolve(value);
  }

  function removeFromQueue(record: TaskRecord): void {
    const state = keys.get(record.key as K);
    if (!state) return;
    const index = state.queue.indexOf(record);
    if (index >= 0) state.queue.splice(index, 1);
    if (!state.running && state.queue.length === 0) keys.delete(record.key as K);
  }

  function cleanupExternalAbortListener(record: TaskRecord): void {
    const listener = record.externalAbortListener;
    if (listener && record.externalSignal) {
      record.externalSignal.removeEventListener("abort", listener);
    }
    record.externalAbortListener = undefined;
  }

  /** Cancel a record without releasing a running slot. */
  function cancel(record: TaskRecord, reason: unknown): void {
    if (record.state === "settled") return;

    const error = abortError(reason);
    record.cancelled = true;
    // abort() is idempotent; keeping this before settle lets a task observe its
    // own signal even when cancellation and completion happen in one turn.
    record.controller.abort(error);

    if (record.state === "queued") {
      record.state = "settled";
      runningRecords.delete(record);
      removeFromQueue(record);
      cleanupExternalAbortListener(record);
      settleRecord(record, error);
      schedule();
      resolveIdleWaitersIfNeeded();
      return;
    }

    // A running task cannot be forcibly stopped. Its promise is rejected now,
    // while finish() releases the slot when the task function settles.
    settleRecord(record, error);
  }

  function finish(
    record: TaskRecord,
    error: unknown,
    value?: unknown,
    isError = true,
  ): void {
    if (record.state !== "running") return;

    record.state = "settled";
    active -= 1;
    runningRecords.delete(record);
    const state = keys.get(record.key as K);
    if (state) {
      state.running = false;
      if (state.queue.length === 0) keys.delete(record.key as K);
    }
    cleanupExternalAbortListener(record);

    // Cancellation may have rejected the caller already; completion still
    // gets to release its slot and cannot replace that rejection.
    if (!record.settled) {
      if (isError) settleRecord(record, error);
      else settleRecord(record, undefined, value, false);
    }

    schedule();
    resolveIdleWaitersIfNeeded();
  }

  function run(record: TaskRecord): void {
    const state = keys.get(record.key as K);
    if (!state || state.running || record.state !== "queued") return;

    const index = state.queue.indexOf(record);
    if (index >= 0) state.queue.splice(index, 1);
    state.running = true;
    record.state = "running";
    active += 1;
    runningRecords.add(record);

    let result: unknown;
    try {
      // The cancellation listener may have fired between candidate selection
      // and this call. In that case do not invoke user code.
      if (record.controller.signal.aborted) {
        finish(record, abortError(record.controller.signal.reason));
        return;
      }
      result = record.task(record.controller.signal);
    } catch (error) {
      finish(record, error);
      return;
    }

    Promise.resolve(result).then(
      (value) => finish(record, undefined, value, false),
      (error) => finish(record, error),
    );
  }

  function score(record: TaskRecord, now: number): number {
    return record.priority + Math.max(0, now - record.enqueuedAt) / agingMs;
  }

  function candidateFor(state: KeyState, now: number): TaskRecord | undefined {
    let best: TaskRecord | undefined;
    let bestScore = -Infinity;
    for (const record of state.queue) {
      const currentScore = score(record, now);
      if (
        !best ||
        currentScore > bestScore ||
        (currentScore === bestScore && record.sequence < best.sequence)
      ) {
        best = record;
        bestScore = currentScore;
      }
    }
    return best;
  }

  function nextCandidate(): TaskRecord | undefined {
    const now = Date.now();
    let best: TaskRecord | undefined;
    let bestScore = -Infinity;
    for (const state of keys.values()) {
      if (state.running || state.queue.length === 0) continue;
      const candidate = candidateFor(state, now);
      if (!candidate) continue;
      const candidateScore = score(candidate, now);
      if (
        !best ||
        candidateScore > bestScore ||
        (candidateScore === bestScore && candidate.sequence < best.sequence)
      ) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    return best;
  }

  function schedule(): void {
    if (scheduleInProgress) {
      scheduleAgain = true;
      return;
    }
    scheduleInProgress = true;
    try {
      do {
        scheduleAgain = false;
        if (closeState === "closed") break;
        while (active < options.concurrency) {
          const candidate = nextCandidate();
          if (!candidate) break;
          run(candidate);
        }
      } while (scheduleAgain);
    } finally {
      scheduleInProgress = false;
    }
  }

  function enqueue<T>(request: EnqueueRequest<T, K>): Promise<T> {
    if (!request || typeof request.task !== "function") {
      return Promise.reject(new TypeError("task must be a function"));
    }
    if (request.priority !== undefined && !Number.isFinite(request.priority)) {
      return Promise.reject(new TypeError("priority must be a finite number"));
    }
    if (closeState !== "open") return Promise.reject(new SchedulerClosedError());

    const priority = request.priority ?? 0;
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve as (value: unknown) => void;
      rejectPromise = reject;
    });
    const controller = new AbortController();
    const record: TaskRecord = {
      key: request.key,
      task: request.task as (signal: AbortSignal) => unknown,
      priority,
      sequence: sequence++,
      enqueuedAt: Date.now(),
      controller,
      externalSignal: request.signal,
      resolve: resolvePromise,
      reject: rejectPromise,
      state: "queued",
      settled: false,
      cancelled: false,
    };

    if (request.signal?.aborted) {
      cancel(record, request.signal.reason);
      return promise;
    }

    if (request.signal) {
      const listener = () => cancel(record, request.signal?.reason);
      record.externalAbortListener = listener;
      request.signal.addEventListener("abort", listener, { once: true });
      // Covers an abort that happens between the check and listener install.
      if (request.signal.aborted) {
        cancel(record, request.signal.reason);
        return promise;
      }
    }

    let state = keys.get(request.key);
    if (!state) {
      state = { queue: [], running: false };
      keys.set(request.key, state);
    }
    state.queue.push(record);
    schedule();
    return promise;
  }

  function close(options: { drain: boolean }): Promise<void> {
    if (!options || typeof options.drain !== "boolean") {
      return Promise.reject(new TypeError("close requires { drain: boolean }"));
    }

    if (closeState === "open") closeState = options.drain ? "draining" : "closed";
    else if (closeState === "draining" && !options.drain) closeState = "closed";

    if (closeState === "closed") {
      for (const state of keys.values()) {
        for (const record of [...state.queue]) cancel(record, new TaskAbortError("Scheduler closed"));
      }
      for (const record of runningRecords) cancel(record, new TaskAbortError("Scheduler closed"));
    }

    schedule();
    return waitForIdle();
  }

  return { enqueue, close };
}
