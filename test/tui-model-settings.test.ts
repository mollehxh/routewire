import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {CodexModelCatalogEntry} from "../src/model-catalog.js";
import type {RunwireInkState} from "../src/tui-ink.js";
import {RunwireTui} from "../src/tui.js";
import {loadRunwireSettings, saveRunwireSettings, DEFAULT_RUNWIRE_SETTINGS} from "../src/tui-settings.js";

const ink = vi.hoisted(() => ({props: undefined as undefined | {state: RunwireInkState; onKey(key: string): void}}));
vi.mock("ink", async importOriginal => ({
  ...await importOriginal<typeof import("ink")>(),
  render: (element: {props: typeof ink.props}) => {
    ink.props = element.props;
    return {unmount() {}, rerender(next: {props: typeof ink.props}) {ink.props = next.props;}};
  },
}));

const luna: CodexModelCatalogEntry = {
  id: "gpt-6-luna", displayName: "Luna", efforts: ["high"], defaultEffort: "high", fastMode: true,
};
const sol: CodexModelCatalogEntry = {...luna, id: "gpt-6.1-sol", displayName: "Sol"};
const cleanup: Array<() => void> = [];
afterEach(() => {for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.unstubAllEnvs();});

function setup(loadModelCatalog: () => readonly CodexModelCatalogEntry[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runwire-model-settings-"));
  cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  saveRunwireSettings({...DEFAULT_RUNWIRE_SETTINGS, allowedSubagentModels: [sol.id, luna.id]});
  const output = Object.assign(new PassThrough(), {isTTY: true}) as unknown as NodeJS.WriteStream;
  const tui = new RunwireTui({cwd: dir, model: luna.id, modelCatalog: [luna], loadModelCatalog, output});
  tui.start();
  cleanup.push(() => tui.stop());
  return tui;
}

function keys(...values: string[]) {for (const key of values) ink.props!.onKey(key);}
function openCodexSettings() {keys("j", "\r", "j", "\r");}

describe("saved subagent model selections", () => {
  it("preserves saved selections during a fallback catalog and unrelated saves, then refreshes metadata", () => {
    let catalog = [luna];
    const tui = setup(() => catalog);
    expect(tui.settings().allowedSubagentModels).toEqual([sol.id, luna.id]);
    openCodexSettings();
    keys("j", "\r"); // Save fast mode while Sol is absent.
    expect(loadRunwireSettings().allowedSubagentModels).toEqual([sol.id, luna.id]);
    catalog = [luna, sol];
    keys("j", "\r"); // Refresh when opening model selections.
    expect(ink.props!.state.modelCatalog.find(entry => entry.id === sol.id)?.displayName).toBe("Sol");
    expect(tui.settings().allowedSubagentModels).toEqual([sol.id, luna.id]);
  });

  it("keeps absent saved models visible and independently removable when another model is toggled", () => {
    const tui = setup(() => [luna]);
    openCodexSettings();
    keys("j", "j", "\r");
    expect(ink.props!.state.modelCatalog.map(entry => entry.id)).toEqual([luna.id, sol.id]);
    keys(" "); // Remove Luna without deleting the absent Sol selection.
    expect(tui.settings().allowedSubagentModels).toEqual([sol.id]);
    expect(loadRunwireSettings().allowedSubagentModels).toEqual([sol.id]);
    keys("j", " "); // Explicitly remove the absent selection.
    expect(loadRunwireSettings().allowedSubagentModels).toEqual([]);
  });
});
