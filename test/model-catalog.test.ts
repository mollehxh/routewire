import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {describe, expect, it} from "vitest";

import {
  loadCodexModelCatalog,
} from "../src/model-catalog.js";

describe("Codex model catalog", () => {
  it("loads visible models and per-model reasoning efforts from models_cache.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-model-catalog-"));
    fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "gpt-6-luna",
          display_name: "GPT-6-Luna",
          visibility: "list",
          default_reasoning_level: "medium",
          multi_agent_reasoning_effort: "high",
          supported_reasoning_levels: [
            {effort: "low"},
            {effort: "medium"},
            {effort: "high"},
            {effort: "xhigh"},
            {effort: "max"},
          ],
          additional_speed_tiers: ["fast"],
        },
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            {effort: "low"},
            {effort: "medium"},
            {effort: "high"},
            {effort: "xhigh"},
          ],
          additional_speed_tiers: [],
        },
        {
          slug: "gpt-visible-without-reasoning-metadata",
          display_name: "Visible without reasoning metadata",
          visibility: "list",
          supported_reasoning_levels: [],
          additional_speed_tiers: [],
        },
        {
          slug: "hidden-model",
          display_name: "Hidden",
          visibility: "hidden",
          supported_reasoning_levels: [{effort: "high"}],
        },
      ],
    }));

    const catalog = loadCodexModelCatalog(root);
    expect(catalog.map(entry => entry.id)).toEqual([
      "gpt-6-luna",
      "gpt-5.5",
      "gpt-visible-without-reasoning-metadata",
    ]);
    expect(catalog[0]).toMatchObject({
      id: "gpt-6-luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      multiAgentEffort: "high",
      fastMode: true,
    });
    expect(catalog[1]).toMatchObject({
      id: "gpt-5.5",
      efforts: ["low", "medium", "high", "xhigh"],
      fastMode: false,
    });
    expect(catalog[2]).toMatchObject({
      id: "gpt-visible-without-reasoning-metadata",
      efforts: [],
      defaultEffort: "high",
      fastMode: false,
    });
  });

});
