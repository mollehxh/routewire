import {afterEach, describe, expect, it, vi} from "vitest";
import {render} from "ink-testing-library";

import {RoutewireInkApp, type RoutewireInkState} from "../src/tui-ink.js";
import type {CodexModelCatalogEntry} from "../src/model-catalog.js";
import {DEFAULT_ROUTEWIRE_SETTINGS} from "../src/tui-settings.js";

const modelCatalog: readonly CodexModelCatalogEntry[] = [
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    multiAgentEffort: "xhigh",
    fastMode: true,
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    multiAgentEffort: "high",
    fastMode: true,
  },
];

const baseState = (): RoutewireInkState => ({
  cwd: "/repo",
  model: "gpt-5.6-sol",
  modelCatalog,
  runtimeState: "running",
  runtimeMessage: "",
  runtimeDirty: false,
  view: "activity",
  selection: 0,
  inputBuffer: "",
  settings: {...DEFAULT_ROUTEWIRE_SETTINGS},
  apiKeyConfigured: false,
  components: new Map([["codex", "ready"], ["tunnel", "stopped"]]),
  active: [],
  recent: [],
  agents: [],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Routewire Ink TUI", () => {
  it("renders a non-blocking startup update check", () => {
    const state = baseState();
    state.runtimeState = "stopped";
    state.view = "update_check";
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Checking for updates");
    expect(frame).toContain("q quit");
    ui.unmount();
  });

  it("renders the startup update choice before the main menu", () => {
    const state = baseState();
    state.runtimeState = "stopped";
    state.view = "update";
    state.update = {
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      command: "npm install -g routewire@latest",
      status: "available",
    };
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Update available");
    expect(frame).toContain("0.1.0");
    expect(frame).toContain("0.2.0");
    expect(frame).toContain("Update now");
    expect(frame).toContain("Continue with 0.1.0");
    expect(frame).toContain("npm install -g routewire@latest");
    ui.unmount();
  });

  it("keeps the top level to Start, Settings, Activity, and Quit", () => {
    const state = baseState();
    state.runtimeState = "stopped";
    state.view = "menu";
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Start");
    expect(frame).toContain("Settings");
    expect(frame).toContain("Activity");
    expect(frame).toContain("Quit");
    expect(frame).toContain("//>");
    expect(frame).toContain("R O U T E W I R E");
    expect(frame).toContain("Local Codex bridge for ChatGPT");
    expect(frame).toContain("/repo");
    expect(frame).not.toContain("ready");
    expect(frame).not.toContain("workspace write");
    expect(frame).not.toMatch(/^\s*Connection\s*$/m);
    expect(frame).not.toMatch(/^\s*Codex\s*$/m);
    expect(frame).not.toMatch(/^\s*Agents\s*$/m);
    const lastNonEmptyLine = frame.split("\n").filter(line => line.trim()).at(-1) ?? "";
    expect(lastNonEmptyLine).toContain("↑↓ move");
    expect(lastNonEmptyLine).toContain("enter start");
    expect(lastNonEmptyLine).toContain("q quit");
    ui.unmount();
  });

  it("uses a pause icon for the running Stop action", () => {
    const state = baseState();
    state.view = "menu";
    state.runtimeState = "running";
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toMatch(/Ⅱ\s+Stop/);
    ui.unmount();
  });

  it("renders Settings as a drill-down menu with a breadcrumb and pinned footer", () => {
    const state = baseState();
    state.view = "settings";
    state.selection = 0;
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("//>  settings");
    expect(frame).not.toContain("/repo");
    expect(frame).toContain("Connection");
    expect(frame).toContain("Codex");
    expect(frame).not.toContain("Agents");
    expect(frame).not.toContain("Remote access");
    expect(frame).not.toContain("Permissions");
    const lastNonEmptyLine = frame.split("\n").filter(line => line.trim()).at(-1) ?? "";
    expect(lastNonEmptyLine).toContain("↑↓ move");
    expect(lastNonEmptyLine).toContain("enter open");
    expect(lastNonEmptyLine).toContain("esc back");
    expect(lastNonEmptyLine).toContain("permissions  Workspace write");
    expect(frame).toContain("─");
    expect(frame).not.toMatch(/[╭╮╰╯]/);
    ui.unmount();
  });

  it("renders Connection settings as its own submenu", () => {
    const state = baseState();
    state.view = "settings_connection";
    state.selection = 0;
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("//>  settings / connection");
    expect(frame).not.toContain("Remote access");
    expect(frame).toContain("Tunnel ID");
    expect(frame).toContain("API key");
    expect(frame).not.toContain("Permissions");
    ui.unmount();
  });

  it("renders Codex settings as its own submenu", () => {
    const state = baseState();
    state.view = "settings_codex";
    state.selection = 0;
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("//>  settings / codex");
    expect(frame).toContain("Permissions");
    expect(frame).toContain("Workspace write");
    expect(frame).toContain("‹ Workspace write ›");
    expect(frame).not.toContain("Approvals");
    expect(frame).toContain("Fast mode");
    expect(frame).toContain("‹ On ›");
    expect(frame).toContain("Subagent models");
    expect(frame).toContain("1/2 available");
    expect(frame).not.toContain("Tunnel ID");
    ui.unmount();
  });

  it("renders subagent model allowlist in the same style as Settings", () => {
    const state = baseState();
    state.view = "agent_models";
    state.selection = 0;
    state.settings = {
      ...state.settings,
      allowedSubagentModels: ["gpt-6.1-sol", "gpt-6-luna"],
    };
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("//>  settings / codex / subagent models");
    expect(frame).toContain("gpt-6.1-sol");
    expect(frame).toContain("Available");
    expect(frame).toContain("gpt-6-luna");
    expect(frame).not.toContain("‹ ultra ›");
    expect(frame).not.toContain("default");
    expect(frame).not.toContain("effort:");
    expect(frame).toContain("! Subagents consume your Codex plan usage.");
    ui.unmount();
  });
  it("renders Activity as a flat live feed without Details", () => {
    const now = Date.now();
    const state = baseState();
    state.active = [{
      callId: "call-1",
      namespace: "functions",
      name: "exec",
      kind: "shell",
      target: "npm test",
      startedAt: now - 2_000,
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    const headerLine = frame.split("\n").find(line => line.includes("//>  activity")) ?? "";
    expect(headerLine).toContain("//>  activity");
    expect(headerLine).toContain("1 event");
    expect(frame).toContain("/repo");
    expect(frame).toContain("shell");
    expect(frame).toContain("npm test");
    expect(frame).toContain("running");
    expect(frame).toContain("1 event");
    expect(frame).not.toContain("Live");
    expect(frame).not.toContain("History");
    expect(frame).not.toContain("codex");
    expect(frame).not.toContain("Details");
    expect(frame).not.toContain("▌");
    ui.unmount();
  });

  it("keeps active agents in a rounded rail with live elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-02T12:00:00.000Z");
    vi.setSystemTime(start);
    const state = baseState();
    state.recent = [{
      callId: "shell-call",
      namespace: "functions",
      name: "exec",
      kind: "shell",
      target: "npm test",
      startedAt: start.getTime() - 1_000,
      durationMs: 121,
    }];
    state.agents = [{
      taskName: "review_tests",
      model: "gpt-6-luna",
      reasoning: "high",
      status: "working",
      startedAt: start.getTime() - 5_000,
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Agents 1 active");
    expect(frame).toContain("review_tests");
    expect(frame).toContain("5s");
    expect(frame).toMatch(/[╭╮╰╯]/);
    expect(frame).not.toContain("gpt-6-luna  high");
    expect(frame).not.toContain("working");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(ui.lastFrame()).toContain("7s");
    ui.unmount();
  });

  it("shows model and effort on spawn activity instead of in the sidebar", () => {
    const now = Date.now();
    const state = baseState();
    state.recent = [{
      callId: "agent-call",
      namespace: "collaboration",
      name: "spawn_agent",
      kind: "spawn",
      target: "review_tests",
      detail: "gpt-6-luna  high",
      startedAt: now - 1_000,
      durationMs: 121,
      agentTaskName: "review_tests",
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("review_tests");
    expect(frame).toContain("gpt-6-luna  high");
    expect(frame).toContain("121ms");
    expect(frame).not.toContain("Agents");
    ui.unmount();
  });

  it("renders active agents as a compact right sidebar on wide terminals", () => {
    const now = Date.now();
    const state = baseState();
    state.recent = [{
      callId: "shell-call",
      namespace: "functions",
      name: "exec",
      kind: "shell",
      target: "npm test",
      startedAt: now - 1_000,
      durationMs: 120,
    }];
    state.agents = [{
      taskName: "review_tests",
      model: "gpt-6-luna",
      reasoning: "high",
      status: "working",
      startedAt: now - 5_000,
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("npm test");
    expect(frame).toContain("Agents 1 active");
    expect(frame).toMatch(/[╭╮╰╯]/);
    ui.unmount();
  });

  it("does not reserve or render an Agents sidebar when no agent is active", () => {
    const state = baseState();
    state.agents = [];
    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    expect(ui.lastFrame()).not.toContain("Agents");
    ui.unmount();
  });

  it("hides completed agents from the active rail", () => {
    const now = Date.now();
    const state = baseState();
    state.recent = [
      {
        callId: "spawn-call",
        namespace: "collaboration",
        name: "spawn_agent",
        kind: "spawn",
        target: "review_tests",
        startedAt: now - 30_000,
        durationMs: 100,
        agentTaskName: "review_tests",
      },
      {
        callId: "done-call",
        namespace: "collaboration",
        name: "agent_message",
        kind: "done",
        target: "review_tests",
        startedAt: now - 18_000,
        durationMs: 12_000,
        agentTaskName: "review_tests",
      },
    ];
    state.agents = [{
      taskName: "review_tests",
      model: "gpt-6-luna",
      reasoning: "high",
      status: "done",
      startedAt: now - 30_000,
      durationMs: 12_000,
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("done");
    expect(frame).toContain("12s");
    expect(frame).not.toContain("Agents 1 active");
    ui.unmount();
  });

  it("keeps the active agent rail visible while Activity is scrolled", () => {
    const now = Date.now();
    const state = baseState();
    state.selection = 12;
    state.recent = Array.from({length: 30}, (_, index) => ({
      callId: `call-${index}`,
      namespace: "functions",
      name: "exec",
      kind: "shell" as const,
      target: `command-${index}`,
      startedAt: now + index * 1_000,
      durationMs: 100 + index,
      isError: false,
    }));
    state.agents = [{
      taskName: "review_tests",
      model: "gpt-6-luna",
      reasoning: "high",
      status: "working",
      startedAt: now - 5_000,
    }];

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("30 events");
    expect(frame).not.toContain("Live");
    expect(frame).not.toContain("History");
    expect(frame).toContain("Agents 1 active");
    expect(frame).toContain("review_tests");
    expect(frame).toContain("5s");
    expect(frame).not.toContain("working");
    expect(frame).not.toContain("earlier");
    expect(frame).not.toContain("newer");
    ui.unmount();
  });

  it("orders Activity chronologically so new events append at the bottom", () => {
    const now = Date.now();
    const state = baseState();
    state.selection = 0;
    state.recent = Array.from({length: 4}, (_, index) => ({
      callId: `call-${index}`,
      namespace: "functions",
      name: "exec",
      kind: "shell" as const,
      target: `command-${index}`,
      startedAt: now + index * 1_000,
      durationMs: 100 + index,
      isError: false,
    }));

    const ui = render(<RoutewireInkApp state={state} onKey={() => undefined}/>);
    const frame = ui.lastFrame() ?? "";
    expect(frame.indexOf("command-0")).toBeLessThan(frame.indexOf("command-1"));
    expect(frame.indexOf("command-1")).toBeLessThan(frame.indexOf("command-2"));
    expect(frame.indexOf("command-2")).toBeLessThan(frame.indexOf("command-3"));
    expect(frame).not.toContain("Details");
    ui.unmount();
  });

  it("scrolls Activity as a normal viewport and jumps back to the latest tail", async () => {
    const now = Date.now();
    const events = Array.from({length: 30}, (_, index) => ({
      callId: `call-${index}`,
      namespace: "functions",
      name: "exec",
      kind: "shell" as const,
      target: `command-${index}`,
      startedAt: now + index * 1_000,
      durationMs: 100 + index,
      isError: false,
    }));

    const liveState = baseState();
    liveState.selection = 0;
    liveState.recent = events;
    const live = render(<RoutewireInkApp state={liveState} onKey={() => undefined}/>);
    const liveFrame = live.lastFrame() ?? "";
    expect(liveFrame).toContain("command-29");
    expect(liveFrame).toContain("30 events");
    const liveLines = liveFrame.split("\n");
    const tailLine = liveLines.findIndex(line => line.includes("command-29"));
    expect(tailLine).toBeGreaterThanOrEqual(0);
    expect(liveLines[tailLine + 1]?.trim()).toBe("");
    expect(liveLines[tailLine + 2]).toMatch(/─/);
    expect(liveFrame).not.toContain("Live");
    expect(liveFrame).not.toContain("History");
    expect(liveFrame).not.toContain("command-0");

    live.stdin.write("\u001b[A");
    await new Promise(resolve => setTimeout(resolve, 0));
    const scrolledUp = live.lastFrame() ?? "";
    expect(scrolledUp).not.toContain("command-29");
    expect(scrolledUp).not.toContain("earlier");
    expect(scrolledUp).not.toContain("newer");

    live.stdin.write("\u001b[B");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(live.lastFrame()).toContain("command-29");

    const withNewTail = {
      ...liveState,
      recent: [...events, {
        callId: "call-30",
        namespace: "functions",
        name: "exec",
        kind: "shell" as const,
        target: "command-30",
        startedAt: now + 30_000,
        durationMs: 130,
        isError: false,
      }],
    };
    live.rerender(<RoutewireInkApp state={withNewTail} onKey={() => undefined}/>);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(live.lastFrame()).toContain("command-30");

    live.stdin.write("\u001b[A");
    await new Promise(resolve => setTimeout(resolve, 0));
    const scrolledBeforeNewEvent = live.lastFrame() ?? "";
    expect(scrolledBeforeNewEvent).not.toContain("command-30");
    const whileScrolled = {
      ...withNewTail,
      recent: [...withNewTail.recent, {
        callId: "call-31",
        namespace: "functions",
        name: "exec",
        kind: "shell" as const,
        target: "command-31",
        startedAt: now + 31_000,
        durationMs: 131,
        isError: false,
      }],
    };
    live.rerender(<RoutewireInkApp state={whileScrolled} onKey={() => undefined}/>);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(live.lastFrame()).not.toContain("command-31");
    live.stdin.write("g");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(live.lastFrame()).toContain("command-31");
    live.unmount();
  });
});
