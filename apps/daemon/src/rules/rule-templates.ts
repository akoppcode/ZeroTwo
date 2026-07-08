/**
 * Rules Studio rule model + template gallery (spec §10). Rules are Fab Inspector
 * (PBI Inspector V2) JSON-Logic rules — `{id, name, description, disabled, part,
 * test, logType}`. Zero Two rules additionally carry a `zerotwo` hint so the
 * form builder and the CI mock can evaluate templated shapes deterministically;
 * the real CLI uses the `test` JSON-Logic (see docs/architecture.md). No rules
 * ship enabled — templates become rules only when the user creates from one.
 */

export type RuleSeverity = "warning" | "error";

/** Zero Two hint for templated rule shapes the mock/form-builder understand. */
export interface ZeroTwoRuleHint {
  check: "maxVisualsPerPage";
  maxVisuals: number;
}

export interface FabInspectorRule {
  id: string;
  name: string;
  description: string;
  disabled: boolean;
  part: string;
  /** JSON-Logic test (executed by the real CLI). */
  test: unknown;
  logType: RuleSeverity;
  /** Zero Two extension (ignored by the real CLI). */
  zerotwo?: ZeroTwoRuleHint;
}

export interface RuleSet {
  rules: FabInspectorRule[];
}

export interface RuleTemplate {
  templateId: string;
  title: string;
  description: string;
  defaultSeverity: RuleSeverity;
  /** Build a concrete rule from the template + user parameters. */
  build: (params: Record<string, number | string>) => FabInspectorRule;
}

function maxVisualsRule(maxVisuals: number, severity: RuleSeverity): FabInspectorRule {
  return {
    id: `MAX_VISUALS_PER_PAGE_${maxVisuals}`,
    name: `At most ${maxVisuals} visuals per page`,
    description: `Flags any report page with more than ${maxVisuals} visuals.`,
    disabled: false,
    part: "Page",
    // JSON-Logic for the real CLI: page visual count <= maxVisuals.
    test: [{ "<=": [{ count: { var: "Visuals" } }, maxVisuals] }, {}, true],
    logType: severity,
    zerotwo: { check: "maxVisualsPerPage", maxVisuals },
  };
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    templateId: "max-visuals-per-page",
    title: "Max visuals per page",
    description: "Keep pages readable by capping how many visuals a page can have.",
    defaultSeverity: "warning",
    build: (params) => maxVisualsRule(Number(params.maxVisuals ?? 10), (params.severity as RuleSeverity) ?? "warning"),
  },
  {
    templateId: "hidden-tooltip-drillthrough-pages",
    title: "Tooltip / drillthrough pages hidden",
    description: "Tooltip and drillthrough pages should be hidden from normal view.",
    defaultSeverity: "warning",
    build: (params) => ({
      id: "HIDDEN_TOOLTIP_DRILLTHROUGH_PAGES",
      name: "Tooltip / drillthrough pages are hidden",
      description: "Flags tooltip/drillthrough pages that are visible in view mode.",
      disabled: false,
      part: "Page",
      test: [{ var: "page.visibility" }, {}, "HiddenInViewMode"],
      logType: (params.severity as RuleSeverity) ?? "warning",
    }),
  },
  {
    templateId: "axis-titles-required",
    title: "Axis titles required",
    description: "Cartesian charts should show axis titles.",
    defaultSeverity: "warning",
    build: (params) => ({
      id: "AXIS_TITLES_REQUIRED",
      name: "Axis titles are shown",
      description: "Flags cartesian visuals missing an axis title.",
      disabled: false,
      part: "Visuals",
      test: [{ var: "visual.objects.categoryAxis.showTitle" }, {}, true],
      logType: (params.severity as RuleSeverity) ?? "warning",
    }),
  },
];

export function buildRuleFromTemplate(templateId: string, params: Record<string, number | string>): FabInspectorRule | null {
  const template = RULE_TEMPLATES.find((t) => t.templateId === templateId);
  return template ? template.build(params) : null;
}
