import { describe, expect, it, vi } from "vitest";
import {
  createKeyedTaskScheduler,
  SchedulerClosedError,
} from "../src/keyed-task-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedTaskScheduler", () => {
  it("enforces global concurrency and serializes each key", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 2 });
    const first = deferred<void>();
    const started: string[] = [];

    const a1 = scheduler.enqueue({
      key: "a",
      task: async () => {
        started.push("a1");
        await first.promise;
      },
    });
    const a2 = scheduler.enqueue({
      key: "a",
      task: async () => {
        started.push("a2");
      },
    });
    const b1 = scheduler.enqueue({
      key: "b",
      task: async () => {
        started.push("b1");
      },
    });

    await b1;
    expect(started).toEqual(["a1", "b1"]);
    first.resolve();
    await Promise.all([a1, a2]);
    expect(started).toEqual(["a1", "b1", "a2"]);
    await scheduler.close({ drain: true });
  });

  it("chooses a higher priority task first when a slot opens", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const order: string[] = [];

    const running = scheduler.enqueue({
      key: "running",
      task: async () => gate.promise,
    });
    const low = scheduler.enqueue({
      key: "low",
      priority: 0,
      task: async () => order.push("low"),
    });
    const high = scheduler.enqueue({
      key: "high",
      priority: 10,
      task: async () => order.push("high"),
    });
    gate.resolve();
    await Promise.all([running, low, high]);
    expect(order).toEqual(["high", "low"]);
    await scheduler.close({ drain: true });
  });

  it("ages waiting work so a low priority task cannot starve", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createKeyedTaskScheduler({ concurrency: 1, agingMs: 10 });
      const gate = deferred<void>();
      const order: string[] = [];
      const running = scheduler.enqueue({ key: "running", task: async () => gate.promise });
      const low = scheduler.enqueue({
        key: "low",
        priority: 0,
        task: async () => order.push("low"),
      });
      vi.advanceTimersByTime(100);
      const high = scheduler.enqueue({
        key: "high",
        priority: 5,
        task: async () => order.push("high"),
      });
      gate.resolve();
      await Promise.all([running, low, high]);
      expect(order[0]).toBe("low");
      await scheduler.close({ drain: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invoke a task whose signal aborts while queued", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const controller = new AbortController();
    const running = scheduler.enqueue({ key: "running", task: async () => gate.promise });
    let invoked = false;
    const cancelled = scheduler.enqueue({
      key: "queued",
      signal: controller.signal,
      task: async () => {
        invoked = true;
      },
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(invoked).toBe(false);
    gate.resolve();
    await running;
    await scheduler.close({ drain: true });
  });

  it("aborts the task-owned signal and rejects during execution", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const controller = new AbortController();
    let ownSignal!: AbortSignal;
    const running = scheduler.enqueue({
      key: "a",
      signal: controller.signal,
      task: async (signal) => {
        ownSignal = signal;
        await gate.promise;
      },
    });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(ownSignal.aborted).toBe(true);
    gate.resolve();
    await scheduler.close({ drain: true });
  });

  it("drains queued work and rejects new work after close({drain:true})", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const order: string[] = [];
    const first = scheduler.enqueue({ key: "a", task: async () => gate.promise });
    const second = scheduler.enqueue({ key: "b", task: async () => order.push("second") });
    const closing = scheduler.close({ drain: true });
    await expect(
      scheduler.enqueue({ key: "c", task: async () => undefined }),
    ).rejects.toBeInstanceOf(SchedulerClosedError);
    gate.resolve();
    await Promise.all([first, second, closing]);
    expect(order).toEqual(["second"]);
  });

  it("cancels queued and running work with close({drain:false})", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    let ownSignal!: AbortSignal;
    let queuedInvoked = false;
    const running = scheduler.enqueue({
      key: "a",
      task: async (signal) => {
        ownSignal = signal;
        await gate.promise;
      },
    });
    const queued = scheduler.enqueue({
      key: "b",
      task: async () => {
        queuedInvoked = true;
      },
    });
    const closing = scheduler.close({ drain: false });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(ownSignal.aborted).toBe(true);
    expect(queuedInvoked).toBe(false);
    gate.resolve();
    await closing;
  });

  it("releases a slot after task failure and continues scheduling", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const failure = new Error("boom");
    const order: string[] = [];
    const failed = scheduler.enqueue({ key: "a", task: async () => { throw failure; } });
    const next = scheduler.enqueue({ key: "b", task: async () => { order.push("next"); } });
    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBeUndefined();
    expect(order).toEqual(["next"]);
    await scheduler.close({ drain: true });
  });

  it("wins a cancel/complete race exactly once and still runs the next key", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<string>();
    const controller = new AbortController();
    let nextInvoked = false;
    const current = scheduler.enqueue({
      key: "a",
      signal: controller.signal,
      task: async () => gate.promise,
    });
    const next = scheduler.enqueue({
      key: "b",
      task: async () => { nextInvoked = true; },
    });
    controller.abort();
    gate.resolve("late value");
    await expect(current).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toBeUndefined();
    expect(nextInvoked).toBe(true);
    await scheduler.close({ drain: true });
  });

  it("can escalate a draining close to an immediate close", async () => {
    const scheduler = createKeyedTaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const running = scheduler.enqueue({ key: "a", task: async () => gate.promise });
    const queued = scheduler.enqueue({ key: "b", task: async () => undefined });
    const closing = scheduler.close({ drain: true });
    const escalated = scheduler.close({ drain: false });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([closing, escalated]);
  });
});
