import { claudeAgentDef } from './defs/claude.js';
import { copilotAgentDef } from './defs/copilot.js';
import type { RuntimeAgentDef } from './types.js';

// Zero Two supports exactly two agents, both via subscription login only
// (ZERO-TWO-IMPLEMENTATION-SPEC.md §1/§5). No local-profile extension point.
const BASE_AGENT_DEFS: RuntimeAgentDef[] = [claudeAgentDef, copilotAgentDef];

export const AGENT_DEFS: RuntimeAgentDef[] = [...BASE_AGENT_DEFS];

const ids = new Set();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) {
    throw new Error(`Duplicate agent definition id: ${def.id}`);
  }
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
