import type { Express } from "express";
import type { RouteDeps } from "../server-context.js";
import { detectPowerBiDesktopVersion } from "../environment/powerbi-desktop-detect.js";
import { runDoctorChecks } from "../environment/environment-service.js";

/**
 * GET /api/doctor — runs the environment checks (spec §3.3) and returns a
 * DoctorReport for the Doctor screen. Local-only, like the other app-shell
 * routes. Each request re-runs the checks so the renderer's "Re-check" button
 * reflects live state (e.g. the Desktop bridge connecting once a report opens).
 */
export interface RegisterDoctorRoutesDeps extends RouteDeps<"http"> {}

export function registerDoctorRoutes(app: Express, ctx: RegisterDoctorRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;

  app.get("/api/doctor", async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    try {
      const report = await runDoctorChecks({
        now: new Date().toISOString(),
        detectPowerBiDesktopVersion: () => detectPowerBiDesktopVersion(),
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });
}
