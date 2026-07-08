import type { Express } from "express";
import type { RouteDeps } from "../server-context.js";
import { detectAuth, guidedLoginCommand } from "../provisioning/auth-service.js";
import { ProvisioningService } from "../provisioning/provisioning-service.js";
import type { ProvisioningAgent } from "../provisioning/provisioning-plan.js";
import { spawnEnvForAgent } from "../agents.js";

/**
 * Agent auth + provisioning routes (spec §5.2/§5.3). GET the subscription-auth
 * status (with the CLI login command when signed out); POST provision streams
 * each install step over SSE and finishes with the verified report. Local-only.
 * The provisioning child env goes through spawnEnvForAgent so API keys are
 * stripped before any agent CLI runs.
 */
export interface RegisterAgentProvisionRoutesDeps extends RouteDeps<"http"> {}

function isAgent(value: unknown): value is ProvisioningAgent {
  return value === "claude" || value === "copilot";
}

export function registerAgentProvisionRoutes(app: Express, ctx: RegisterAgentProvisionRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef, createSseResponse } = ctx.http;
  const getPort = () => resolvedPortRef.current;
  const service = new ProvisioningService();
  const childEnv = (agent: ProvisioningAgent) => spawnEnvForAgent(agent, process.env as Record<string, string>);

  app.get("/api/agents/:agent/auth", async (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const agent = req.params.agent;
    if (!isAgent(agent)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "unknown agent" } });
    }
    try {
      const status = await detectAuth(agent);
      res.json({ ...status, loginCommand: status.loggedIn ? null : guidedLoginCommand(agent) });
    } catch (err: any) {
      res.status(500).json({ error: { code: "AUTH_CHECK_FAILED", message: String(err?.message ?? err) } });
    }
  });

  app.post("/api/agents/provision", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const agent = req.body?.agent;
    const projectPath = typeof req.body?.projectPath === "string" ? req.body.projectPath.trim() : "";
    if (!isAgent(agent)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "agent must be claude or copilot" } });
    }
    if (!projectPath) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "projectPath is required" } });
    }

    const sse = createSseResponse(res);
    let seq = 0;
    const emit = (event: string, data: unknown) => sse.send(event, data, ++seq);

    emit("start", { agent, steps: undefined });
    void (async () => {
      try {
        const report = await service.provision(agent, {
          cwd: projectPath,
          env: childEnv(agent),
          onStep: (step) => emit("step", step),
        });
        emit("report", report);
        emit("done", { verified: report.verified });
      } catch (err: any) {
        emit("error", { message: String(err?.message ?? err) });
      } finally {
        sse.end();
      }
    })();
  });
}
