import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startSideband } from "../src/runtime.js";

const runRealCodex = process.env.SIDEBAND_REAL_CODEX === "1";

describe.skipIf(!runRealCodex)("real Codex runtime", () => {
  it(
    "round-trips an MCP exec call through a live Codex turn without Codex inference",
    async () => {
      const runtime = await startSideband({
        cwd: process.cwd(),
        model: "gpt-5.6-sol",
        codexHome:
          process.env.SIDEBAND_REAL_CODEX_HOME ?? path.join(os.homedir(), ".codex"),
        dangerFullAccess: true,
        quietCodex: true,
      });

      const client = new Client({ name: "sideband-real-smoke", version: "0.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcpUrl)));

        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(1);
        expect(listed.tools[0].name).toBe("exec");
        expect(listed.tools[0].description).toContain("exec_command");

        const policy = await client.callTool({
          name: "exec",
          arguments: {
            code: [
              "const modelTools = ALL_TOOLS.filter(x => /spawn_agent|spawn_session|run_model|collaboration__/i.test(x.name)).map(x => x.name);",
              "let blocked = false;",
              "try { void tools.mcp__sideband_probe__collaboration__spawn_agent; } catch (error) { blocked = String(error).includes('Sideband blocked model-spawning tool'); }",
              "text({ modelTools, blocked, execAvailable: typeof tools.exec_command === 'function' });",
            ].join("\n"),
          },
        });
        const policyText = policy.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(policyText).toContain('"modelTools":[]');
        expect(policyText).toContain('"blocked":true');
        expect(policyText).toContain('"execAvailable":true');

        const result = await client.callTool({
          name: "exec",
          arguments: {
            code: [
              "const result = await tools.exec_command({",
              '  cmd: "printf SIDEBAND_REAL_RUNTIME_OK",',
              "  login: false",
              "});",
              "text(result);",
            ].join("\n"),
          },
        });

        const text = result.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(text).toContain("SIDEBAND_REAL_RUNTIME_OK");

        const discovery = await client.callTool({
          name: "exec",
          arguments: {
            code: [
              "const names = ALL_TOOLS.map(x => x.name);",
              "text({",
              "  browser: names.filter(name => /node_repl|cua_repl/i.test(name)),",
              "  modelTools: names.filter(name => /spawn_agent|spawn_session|run_model|collaboration__/i.test(name)),",
              "});",
            ].join("\n"),
          },
        });

        const discoveryText = discovery.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(discoveryText).toContain("node_repl");
        expect(discoveryText).toContain("cua_repl");
        expect(discoveryText).toContain('"modelTools":[]');

        const browser = await client.callTool({
          name: "exec",
          arguments: {
            code: [
              "const nodeTool = ALL_TOOLS.find(x => x.name === 'mcp__node_repl__js') ?? ALL_TOOLS.find(x => /node_repl__js$/i.test(x.name)) ?? ALL_TOOLS.find(x => /node_repl/i.test(x.name) && !/reset|add_node_module/i.test(x.name) && /browser|javascript|repl/i.test(String(x.description ?? '')));",
              "if (!nodeTool) throw new Error('node_repl is not exposed');",
              "const result = await tools[nodeTool.name]({ code: \"nodeRepl.write('SIDEBAND_BROWSER_OK')\", title: 'Sideband Browser smoke' });",
              "text({ name: nodeTool.name, ok: result?.isError !== true, result });",
            ].join("\n"),
          },
        });
        const browserText = browser.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(browserText).toContain("node_repl");
        expect(browserText).toContain("SIDEBAND_BROWSER_OK");
        expect(browserText).toContain('"ok":true');

        const cua = await client.callTool({
          name: "exec",
          arguments: {
            code: [
              "const cuaTool = ALL_TOOLS.find(x => /cua_repl__js$/i.test(x.name)) ?? ALL_TOOLS.find(x => /computer_repl/i.test(x.name) && /cua|computer use/i.test(String(x.description ?? '')));",
              "if (!cuaTool) throw new Error('cua_repl is not exposed');",
              "const result = await tools[cuaTool.name]({ code: \"await cua.getState();\", title: 'Sideband CUA smoke', timeout_ms: 10000 });",
              "text({ name: cuaTool.name, ok: result?.isError !== true });",
            ].join("\n"),
          },
        });
        const cuaText = cua.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(cuaText).toContain("cua_repl");
        expect(cuaText).toContain('"ok":true');
      } finally {
        await client.close().catch(() => undefined);
        await runtime.close();
      }
    },
    45_000,
  );
});
