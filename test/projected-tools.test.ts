import { describe, expect, it, vi } from "vitest";
import type {CodexTurnBridge} from "../src/bridge.js";

import { discoverProjectedNativeTools, invokeProjectedNativeTool, selectProjectedNativeTools } from "../src/mcp/projected-tools.js";

describe("projected Codex native tools", () => {
  it("continues yielded calls through native functions.wait and preserves all output", async () => {
    const invokeExec = vi.fn(async () => ({isError:false,content:[{type:"text",text:"Script running with cell ID 2\nWall time 30 seconds\nOutput:"},{type:"text",text:"first chunk"}]}));
    const invokeFunction = vi.fn().mockResolvedValueOnce({isError:false,content:[{type:"text",text:"Script running with cell ID 2\nWall time 10 seconds\nOutput:"},{type:"text",text:"second chunk"}]}).mockResolvedValueOnce({isError:false,content:[{type:"text",text:"Script completed\nWall time 5 seconds\nOutput:"},{type:"text",text:"final result"}]});
    const bridge = {invokeExec,invokeFunction,hasFunctionTool:()=>true,functionTools:()=>[{name:"wait"}]} as unknown as CodexTurnBridge;
    const [tool] = selectProjectedNativeTools([{name:"mcp__node_repl__js",description:"REPL"}]);
    const result = await invokeProjectedNativeTool(bridge,tool,{code:"slow()"});
    expect(invokeFunction).toHaveBeenCalledWith("functions","wait",{cell_id:"2",yield_time_ms:10000});
    expect(result).toEqual({isError:false,content:[{type:"text",text:"first chunk"},{type:"text",text:"second chunk"},{type:"text",text:"final result"}]});
  });

  it("terminates a yielded cell on cancellation and retains final native errors", async () => {
    const controller = new AbortController();
    const invokeExec = vi.fn(async () => {controller.abort(new Error("cancelled"));return {isError:false,content:[{type:"text",text:"Script running with cell ID 3\n"}]};});
    const invokeFunction = vi.fn(async () => ({isError:false,content:[]}));
    const bridge = {invokeExec,invokeFunction,hasFunctionTool:()=>true,functionTools:()=>[{name:"wait"}]} as unknown as CodexTurnBridge;
    const [tool] = selectProjectedNativeTools([{name:"mcp__node_repl__js",description:"REPL"}]);
    await expect(invokeProjectedNativeTool(bridge,tool,{code:"slow()"},{signal:controller.signal})).rejects.toThrow("cancelled");
    await expect.poll(() => invokeFunction.mock.calls.length).toBe(1);
    expect(invokeFunction).toHaveBeenCalledWith("functions","wait",{cell_id:"3",terminate:true});
    invokeExec.mockImplementationOnce(async () => ({isError:true,content:[{type:"text",text:"native failure"}]}));
    expect((await invokeProjectedNativeTool(bridge,tool,{code:"bad()"})).isError).toBe(true);
  });

  it("discovers CUA on a later refresh and exposes native wait outside nested ALL_TOOLS", async () => {
    let cycle=0;
    const bridge = {functionTools:()=>[{name:"wait",description:"Wait native cell"}],invokeExec:async()=>({isError:false,content:[{type:"text",text:`__ROUTEWIRE_NATIVE_INVENTORY_START__${JSON.stringify(++cycle>=3?[{name:"mcp__cua_repl__js",description:"CUA"}]:[])}__ROUTEWIRE_NATIVE_INVENTORY_END__`}]})} as unknown as CodexTurnBridge;
    expect((await discoverProjectedNativeTools(bridge)).map(tool=>tool.name)).toContain("wait");
    expect((await discoverProjectedNativeTools(bridge)).map(tool=>tool.name)).toContain("mcp__cua_repl__js");
  });
  it("projects the small canonical surface and ignores test-harness duplicates", () => {
    const projected = selectProjectedNativeTools([
      { name: "exec_command", description: "EXEC" },
      { name: "write_stdin", description: "STDIN" },
      { name: "apply_patch", description: "PATCH" },
      { name: "view_image", description: "IMAGE" },
      { name: "mcp__node_repl__js", description: "NODE" },
      { name: "mcp__node_repl__js_reset", description: "NODE RESET" },
      { name: "mcp__node_repl__js_add_node_module_dir", description: "NODE MODULE" },
      {
        name: "mcp__codex_apps__test_harnes_0001_cua_repl__js",
        description: "WRONG CUA",
      },
      {
        name: "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js",
        description: "CUA",
      },
      {
        name: "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js_reset",
        description: "CUA RESET",
      },
      {
        name: "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js_add_node_module_dir",
        description: "CUA MODULE",
      },
      { name: "create_goal", description: "GOAL" },
      { name: "mcp__mail__search", description: "MAIL" },
    ]);

    expect(projected.map(tool => tool.name)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "mcp__node_repl__js",
      "mcp__node_repl__js_reset",
      "mcp__node_repl__js_add_node_module_dir",
      "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js",
      "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js_reset",
      "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js_add_node_module_dir",
    ]);
    expect(
      projected.find(tool => tool.name.endsWith("cua_repl__js"))?.nativeName,
    ).toBe(
      "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js",
    );
    expect(projected.find(tool => tool.name === "mcp__node_repl__js")?.description).toBe("NODE");
    const cua = projected.find(tool => tool.name.endsWith("cua_repl__js"));
    expect(cua?.description).toContain("Browser/Chrome skill");
    expect(cua?.description).toContain("await cua.getState();");
    expect(cua?.description).not.toContain("CUA");
    expect(cua?.description.length).toBeLessThan(250);
    expect(projected.find(tool => tool.name.endsWith("cua_repl__js_reset"))?.description).toContain(
      "Apps and browser state are preserved",
    );
    expect(
      projected.find(tool => tool.name.endsWith("cua_repl__js_add_node_module_dir"))?.description,
    ).toContain("node_modules directory");
    expect(projected.some(tool => /goal|mail/i.test(tool.name))).toBe(false);
  });

  it("adapts apply_patch to a structured ChatGPT-facing argument", () => {
    const [tool] = selectProjectedNativeTools([
      { name: "apply_patch", description: "FREEFORM PATCH" },
    ]);

    expect(tool.name).toBe("apply_patch");
    expect(tool.description).not.toContain("FREEFORM");
    expect(tool.description).toContain("apply_patch grammar");
    expect(tool.description).toContain("patch");
    expect(tool.mapArguments({ patch: "*** Begin Patch\n*** End Patch" })).toBe(
      "*** Begin Patch\n*** End Patch",
    );
  });

  it("removes duplicated exec declarations from projected descriptions", () => {
    const [tool] = selectProjectedNativeTools([
      {
        name: "exec_command",
        description:
          "Runs a command in a PTY.\n\nexec tool declaration:\n```ts\ndeclare const tools: { exec_command(args: unknown): Promise<unknown>; };\n```",
      },
    ]);

    expect(tool.description).toBe("Runs a command in a PTY.");
    expect(tool.description).not.toContain("exec tool declaration");
  });
});
