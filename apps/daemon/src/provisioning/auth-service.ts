import { runCli } from "../cli-runner.js";
import type { ProvisioningAgent } from "./provisioning-plan.js";

/**
 * Subscription-auth detection (spec §5.2). Zero Two never handles API keys — it
 * only checks whether the agent CLI is already signed in with the user's
 * subscription, and if not, surfaces the CLI's own login command for the user
 * to run. `<cli> auth status` exits 0 + prints the identity when signed in.
 */

export interface AuthStatus {
  agent: ProvisioningAgent;
  loggedIn: boolean;
  /** Parsed account identity when available (best-effort). */
  user: string | null;
}

export type CliRunner = (
  bin: string,
  argv: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = runCli;

/** The command the user runs to sign in (shown in the UI when logged out). */
export function guidedLoginCommand(agent: ProvisioningAgent): string {
  return agent === "claude" ? "claude /login" : "copilot auth login";
}

function parseUser(agent: ProvisioningAgent, stdout: string): string | null {
  const re = agent === "claude" ? /Logged in as (.+)/i : /Signed in as (.+)/i;
  const match = stdout.match(re);
  return match?.[1]?.trim() ?? null;
}

export async function detectAuth(
  agent: ProvisioningAgent,
  runner: CliRunner = defaultRunner,
  bin: string = agent,
): Promise<AuthStatus> {
  const res = await runner(bin, ["auth", "status"]);
  const loggedIn = res.code === 0;
  return { agent, loggedIn, user: loggedIn ? parseUser(agent, res.stdout) : null };
}
