/**
 * Provisioning command plan (spec §5.3). Resolves the EXACT slash-command
 * sequence Zero Two drives inside the chosen agent CLI to install the Power BI
 * skill/plugin set from the two upstream marketplaces. Command names were read
 * from the upstream READMEs at build time (see docs/ARCHITECTURE.md) — not
 * guessed. Zero Two never vendors these skills; it orchestrates their install
 * from source (§5.3.4).
 */

export type ProvisioningAgent = "claude" | "copilot";

export interface ProvisioningStep {
  /** Slash command as typed inside the CLI REPL, e.g. "/plugin install x@y". */
  command: string;
  /** What this step does, for the provisioning report UI. */
  label: string;
}

/** Microsoft Skills for Fabric — marketplace `fabric-collection`. Only the
 *  powerbi-authoring bundle (brings the Power BI report planning/design/
 *  authoring/management + semantic-model-authoring skills, and registers the
 *  Power BI Modeling MCP server). */
const FABRIC_MARKETPLACE_REPO = "microsoft/skills-for-fabric";
const FABRIC_MARKETPLACE_NAME = "fabric-collection";
const FABRIC_PLUGINS = ["powerbi-authoring"] as const;

/** Community marketplace (data-goblin) — PINNED to release 26.25 (26.26 is a
 *  breaking reorganization, spec §5.3). Covers PBIR/TMDL validation hooks
 *  (pbip), Desktop DAX/measure hooks (pbi-desktop), Deneb/Vega-Lite + SVG +
 *  theming (reports), and DAX / semantic-model work (semantic-models). */
const COMMUNITY_MARKETPLACE_REPO = "data-goblin/power-bi-agentic-development";
const COMMUNITY_MARKETPLACE_NAME = "power-bi-agentic-development";
export const COMMUNITY_PINNED_RELEASE = "26.25" as const;
const COMMUNITY_PLUGINS = ["pbip", "pbi-desktop", "reports", "semantic-models"] as const;

/** The pinned marketplace reference. Both CLIs accept `<repo>@<ref>` on
 *  `marketplace add` to lock the catalog to a release tag. */
function pinnedCommunityRef(): string {
  return `${COMMUNITY_MARKETPLACE_REPO}@v${COMMUNITY_PINNED_RELEASE}`;
}

/**
 * Build the ordered command sequence: add both marketplaces (Microsoft
 * unpinned = latest, community pinned to 26.25), then install each plugin.
 * The command surface is identical across the claude and copilot CLIs
 * (`/plugin marketplace add`, `/plugin install NAME@MARKETPLACE`).
 */
export function buildProvisioningPlan(_agent: ProvisioningAgent): ProvisioningStep[] {
  const steps: ProvisioningStep[] = [];

  steps.push({
    command: `/plugin marketplace add ${FABRIC_MARKETPLACE_REPO}`,
    label: "Add the Microsoft Skills for Fabric marketplace",
  });
  steps.push({
    command: `/plugin marketplace add ${pinnedCommunityRef()}`,
    label: `Add the community marketplace (pinned to release ${COMMUNITY_PINNED_RELEASE})`,
  });

  for (const plugin of FABRIC_PLUGINS) {
    steps.push({
      command: `/plugin install ${plugin}@${FABRIC_MARKETPLACE_NAME}`,
      label: `Install ${plugin}`,
    });
  }
  for (const plugin of COMMUNITY_PLUGINS) {
    steps.push({
      command: `/plugin install ${plugin}@${COMMUNITY_MARKETPLACE_NAME}`,
      label: `Install ${plugin}`,
    });
  }

  return steps;
}

/** The plugins Zero Two expects installed after provisioning — used to verify
 *  the CLI's `/plugin list` output and to build the provisioning report. */
export function expectedInstalledPlugins(): { plugin: string; marketplace: string }[] {
  return [
    ...FABRIC_PLUGINS.map((plugin) => ({ plugin, marketplace: FABRIC_MARKETPLACE_NAME })),
    ...COMMUNITY_PLUGINS.map((plugin) => ({ plugin, marketplace: COMMUNITY_MARKETPLACE_NAME })),
  ];
}
