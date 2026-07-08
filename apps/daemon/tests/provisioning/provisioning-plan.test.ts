import { describe, expect, it } from "vitest";

import {
  buildProvisioningPlan,
  expectedInstalledPlugins,
  COMMUNITY_PINNED_RELEASE,
} from "../../src/provisioning/provisioning-plan.js";

// Golden command sequence (spec §5.3 acceptance: "provisioning issues the exact
// expected command sequences — marketplace add ×2, installs, pinned version").
// Command names were read from the upstream READMEs (docs/ARCHITECTURE.md); a
// change here must be a deliberate re-resolution against those READMEs.
const GOLDEN = [
  "/plugin marketplace add microsoft/skills-for-fabric",
  "/plugin marketplace add data-goblin/power-bi-agentic-development@v26.25",
  "/plugin install powerbi-authoring@fabric-collection",
  "/plugin install pbip@power-bi-agentic-development",
  "/plugin install pbi-desktop@power-bi-agentic-development",
  "/plugin install reports@power-bi-agentic-development",
  "/plugin install semantic-models@power-bi-agentic-development",
];

describe("buildProvisioningPlan", () => {
  it("issues the exact command sequence: both marketplaces then the plugin installs", () => {
    expect(buildProvisioningPlan("claude").map((s) => s.command)).toEqual(GOLDEN);
  });

  it("pins the community marketplace to release 26.25 (26.26 is a breaking reorg)", () => {
    expect(COMMUNITY_PINNED_RELEASE).toBe("26.25");
    const communityAdd = buildProvisioningPlan("claude").find((s) =>
      s.command.includes("data-goblin/power-bi-agentic-development"),
    );
    expect(communityAdd?.command).toContain("@v26.25");
  });

  it("uses the identical command surface for claude and copilot", () => {
    expect(buildProvisioningPlan("claude").map((s) => s.command)).toEqual(
      buildProvisioningPlan("copilot").map((s) => s.command),
    );
  });

  it("installs the Microsoft powerbi-authoring bundle + the pinned community set", () => {
    const installs = buildProvisioningPlan("claude")
      .filter((s) => s.command.startsWith("/plugin install "))
      .map((s) => s.command.replace("/plugin install ", ""));
    expect(installs).toContain("powerbi-authoring@fabric-collection");
    expect(installs).toEqual(
      expectedInstalledPlugins().map((p) => `${p.plugin}@${p.marketplace}`),
    );
  });

  it("every step carries a human label for the provisioning report", () => {
    for (const step of buildProvisioningPlan("claude")) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});
