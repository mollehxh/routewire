import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {RoutewireInkState} from "../src/tui-ink.js";
import {RoutewireTui} from "../src/tui.js";

const ink = vi.hoisted(() => ({props: undefined as undefined | {state: RoutewireInkState; onKey(key: string): void}}));
vi.mock("ink", async importOriginal => ({
  ...await importOriginal<typeof import("ink")>(),
  render: (element: {props: typeof ink.props}) => {
    ink.props = element.props;
    return {unmount() {}, rerender(next: {props: typeof ink.props}) {ink.props = next.props;}};
  },
}));

const cleanup: Array<() => void> = [];
afterEach(() => {for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.unstubAllEnvs();});

function setup(onUpdate = vi.fn()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-update-tui-"));
  cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  const output = Object.assign(new PassThrough(), {isTTY: true}) as unknown as NodeJS.WriteStream;
  const tui = new RoutewireTui({
    cwd: dir,
    model: "gpt-5.6-sol",
    modelCatalog: [],
    output,
    checkingForUpdate: true,
    onUpdate,
  });
  tui.start();
  tui.showAvailableUpdate({
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    action: {command: "npm", args: ["install", "--global", "--prefer-online", "routewire@0.2.0"], display: "npm install -g --prefer-online routewire@0.2.0"},
  });
  cleanup.push(() => tui.stop());
  return {tui, onUpdate};
}

describe("Routewire update prompt", () => {
  it("moves from the startup check to the normal menu when no update exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-update-check-tui-"));
    cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    const output = Object.assign(new PassThrough(), {isTTY: true}) as unknown as NodeJS.WriteStream;
    const tui = new RoutewireTui({cwd: dir, model: "gpt-5.6-sol", modelCatalog: [], output, checkingForUpdate: true});
    tui.start();
    cleanup.push(() => tui.stop());
    expect(ink.props!.state.view).toBe("update_check");
    tui.finishUpdateCheck();
    expect(ink.props!.state.view).toBe("menu");
  });

  it("continues on the old version without suppressing a future launch", () => {
    const {onUpdate} = setup();
    expect(ink.props!.state.view).toBe("update");
    ink.props!.onKey("j");
    ink.props!.onKey("\r");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(ink.props!.state.view).toBe("menu");
    expect(ink.props!.state.update).toBeUndefined();
  });

  it("starts the updater and exposes install errors in the prompt", () => {
    const {tui, onUpdate} = setup();
    ink.props!.onKey("\r");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(ink.props!.state.update?.status).toBe("installing");
    tui.setUpdateError("permission denied");
    expect(ink.props!.state.update).toMatchObject({status: "error", message: "permission denied"});
  });
});
