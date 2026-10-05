import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {RoutewireInkState} from "../src/tui-ink.js";
import {RoutewireTui} from "../src/tui.js";

const ink = vi.hoisted(() => ({props: undefined as undefined | {state: RoutewireInkState}}));

vi.mock("ink", async importOriginal => ({
  ...await importOriginal<typeof import("ink")>(),
  render: (element: {props: typeof ink.props}) => {
    ink.props = element.props;
    return {
      unmount() {},
      rerender(next: {props: typeof ink.props}) {ink.props = next.props;},
    };
  },
}));

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.unstubAllEnvs();
});

describe("Routewire Activity history", () => {
  it("keeps the full runtime session history beyond 40 completed events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-history-"));
    cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
    vi.stubEnv("XDG_CONFIG_HOME", dir);

    const output = Object.assign(new PassThrough(), {isTTY: true}) as unknown as NodeJS.WriteStream;
    const tui = new RoutewireTui({cwd: dir, model: "gpt-5.6-sol", modelCatalog: [], output});
    tui.start();
    cleanup.push(() => tui.stop());
    tui.handle({type: "component", component: "codex", state: "ready"});

    for (let index = 0; index < 55; index += 1) {
      const callId = `call-${index}`;
      tui.handle({
        type: "call_started",
        callId,
        namespace: "functions",
        name: "exec",
        input: `const result = await tools.exec_command({cmd:"echo ${index}"}); text(result);`,
        startedAt: index,
      });
      tui.handle({
        type: "call_finished",
        callId,
        namespace: "functions",
        name: "exec",
        isError: false,
        durationMs: 1,
        output: String(index),
      });
    }

    expect(ink.props!.state.recent).toHaveLength(55);
    expect(ink.props!.state.recent.at(-1)?.callId).toBe("call-0");
  });
});
