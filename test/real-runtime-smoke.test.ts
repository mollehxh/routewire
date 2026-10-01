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
        const listedNames = listed.tools.map(tool => tool.name);
        expect(listedNames).toContain("exec");
        expect(listedNames).toContain("exec_command");
        expect(listedNames).toContain("apply_patch");
        expect(listedNames).toContain("skills");
        expect(listedNames).toContain("get_skill");
        expect(listedNames).toContain("mcp__node_repl__js");
        const cuaToolName = listedNames.find(name => /cua_repl__js$/i.test(name));
        expect(cuaToolName).toBeTruthy();
        expect(listed.tools.find(tool => tool.name === "exec")?.description).toContain(
          "exec_command",
        );
        expect(listed.tools.find(tool => tool.name === "mcp__node_repl__js")?.description).toContain(
          "persistent `node_repl`",
        );

        const skillsResult = await client.callTool({ name: "skills", arguments: {} });
        expect(skillsResult.isError).not.toBe(true);
        const skillsText = skillsResult.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        const skillsPayload = JSON.parse(skillsText) as {
          skills: Array<{ name: string; description: string }>;
        };
        expect(skillsPayload.skills.length).toBeGreaterThan(0);
        expect(skillsPayload.skills.every(skill => skill.name && skill.description)).toBe(true);

        const skillName = skillsPayload.skills[0].name;
        const skillResult = await client.callTool({
          name: "get_skill",
          arguments: { names: [skillName] },
        });
        expect(skillResult.isError).not.toBe(true);
        const skillText = skillResult.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        const skillPayload = JSON.parse(skillText) as {
          skills: Array<{ name: string; content: string }>;
          errors: unknown[];
        };
        expect(skillPayload.errors).toEqual([]);
        expect(skillPayload.skills[0].name).toBe(skillName);
        expect(skillPayload.skills[0].content).toContain("---");

        const directExec = await client.callTool({
          name: "exec_command",
          arguments: { cmd: "printf SIDEBAND_DIRECT_EXEC_OK", login: false },
        });
        const directExecText = directExec.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(directExecText).toContain("SIDEBAND_DIRECT_EXEC_OK");

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
          name: "mcp__node_repl__js",
          arguments: {
            code: "nodeRepl.write('SIDEBAND_BROWSER_OK')",
            title: "Sideband Browser smoke",
          },
        });
        const browserText = browser.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(browserText).toContain("SIDEBAND_BROWSER_OK");

        const cua = await client.callTool({
          name: cuaToolName!,
          arguments: {
            code: "await cua.getState();",
            title: "Sideband CUA smoke",
            timeout_ms: 10000,
          },
        });
        const cuaText = cua.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
        expect(cua.isError).not.toBe(true);
        expect(cuaText.length).toBeGreaterThan(0);
      } finally {
        await client.close().catch(() => undefined);
        await runtime.close();
      }
    },
    75_000,
  );
});
