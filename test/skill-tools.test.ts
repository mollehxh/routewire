import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CodexTurnBridge } from "../src/bridge.js";
import {
  discoverNativeSkillTools,
  invokeRunwireSkillTool,
  loadNativeSkillCatalog,
} from "../src/mcp/skill-tools.js";

describe("Runwire Codex skill tools", () => {
  it("lists and reads the same canonical enabled skill when app-server returns duplicate names", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwire-duplicate-skills-"));
    try {
      const first = join(root, "first.md"), second = join(root, "second.md");
      await writeFile(first, "first canonical body");
      await writeFile(second, "second body");
      const catalog = {data: [{skills: [
        {name: "demo", description: "first", enabled: true, path: first},
        {name: "demo", description: "second", enabled: true, path: second},
      ]}]};
      const command = join(root, "codex");
      await writeFile(command, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id) console.log(JSON.stringify({id:m.id,result:m.method==='skills/list'?${JSON.stringify(catalog)}:{}}));});`, {mode: 0o755});
      const native = {kind: "app-server" as const, command, cwd: root, codexHome: root};
      const bridge = {} as CodexTurnBridge;
      expect(await loadNativeSkillCatalog(bridge, native)).toEqual([{name: "demo", description: "first"}]);
      const read = await invokeRunwireSkillTool(bridge, native, "get_skill", {names: ["demo"]});
      expect(read.isError).toBe(false);
      expect(read.content).toEqual([{type: "text", text: JSON.stringify({skills: [{name:"demo", content:"first canonical body"}]})}]);
    } finally {await rm(root, {recursive:true,force:true});}
  });
  it("emits semantic lifecycle events when reading a skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwire-skill-events-"));
    const skillRoot = join(root, "skills");
    const skillDir = join(skillRoot, "tui-design");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: tui-design\ndescription: UI skill\n---\n\nbody\n",
      "utf8",
    );
    const bridge = {
      invokeExec: async () => { throw new Error("bridge should not be called"); },
    } as unknown as CodexTurnBridge;
    const events: Array<{type: string; name?: string; arguments?: Record<string, unknown>; isError?: boolean}> = [];

    const result = await invokeRunwireSkillTool(
      bridge,
      {kind: "local", roots: [skillRoot]},
      "get_skill",
      {names: ["tui-design"]},
      {onEvent: event => events.push(event)},
    );

    expect(result.isError).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "call_started",
      namespace: "runwire",
      name: "get_skill",
      arguments: {names: ["tui-design"]},
    });
    expect(events[1]).toMatchObject({
      type: "call_finished",
      namespace: "runwire",
      name: "get_skill",
      isError: false,
    });
  });

  it("uses CODEX_HOME skills locally without invoking a nested connector", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwire-local-skills-"));
    const codexHome = join(root, "codex");
    const skillDir = join(codexHome, "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Local demo skill\n---\n\n# Demo\nLocal body.\n",
      "utf8",
    );

    const bridge = {
      invokeExec: async () => {
        throw new Error("nested connector should not be called");
      },
    } as unknown as CodexTurnBridge;

    const nativeTools = await discoverNativeSkillTools(bridge, {
      cwd: root,
      codexHome,
      codexCommand: join(root, "missing-codex"),
    });
    if (!nativeTools) throw new Error("expected local skills");
    expect(nativeTools.kind).toBe("local");
    if (nativeTools.kind !== "local") throw new Error("expected local skill resolver");
    expect(nativeTools.roots).toContain(join(codexHome, "skills"));

    await expect(loadNativeSkillCatalog(bridge, nativeTools)).resolves.toContainEqual(
      { name: "demo-skill", description: "Local demo skill" },
    );

    const result = await invokeRunwireSkillTool(
      bridge,
      nativeTools,
      "get_skill",
      { names: ["demo-skill"] },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}"))
      .toMatchObject({
        skills: [{ name: "demo-skill", content: expect.stringContaining("Local body.") }],
      });
  });
});
