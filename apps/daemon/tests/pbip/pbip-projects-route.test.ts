import type http from "node:http";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer } from "../../src/server.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");

describe("POST /api/projects attach + scaffold", () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("scaffolds a new PBIR project (201) with the report inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-scaffold-route-"));
    const res = await post("/api/projects/scaffold", { name: "Q3 Review", path: join(dir, "q3"), agent: "claude" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: any; report: any };
    expect(body.project).toMatchObject({ kind: "scaffolded", agent: "claude", pageCount: 1, visualCount: 0 });
    expect(body.project.id).toBeTruthy();
    expect(body.project.baselineSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.report.pages).toHaveLength(1);
  });

  it("attaches the PBIR sample (201) with the correct 2-page / 6-visual inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-attach-route-"));
    const dest = join(dir, "sample");
    await cp(join(FIXTURES, "sample.pbip"), dest, { recursive: true });
    const res = await post("/api/projects/attach", { path: dest, agent: "copilot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: any };
    expect(body.project).toMatchObject({
      kind: "attached",
      agent: "copilot",
      pageCount: 2,
      visualCount: 6,
      hasSemanticModel: true,
      semanticModelTmdl: true,
    });
  });

  it("rejects a legacy PBIP with 422 + pbir-legacy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-legacy-route-"));
    const dest = join(dir, "legacy");
    await cp(join(FIXTURES, "legacy-sample.pbip"), dest, { recursive: true });
    const res = await post("/api/projects/attach", { path: dest, agent: "claude" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pbir-legacy");
  });

  it("validates inputs (400 on missing path / bad agent)", async () => {
    expect((await post("/api/projects/attach", { agent: "claude" })).status).toBe(400);
    expect((await post("/api/projects/attach", { path: "/x", agent: "gpt" })).status).toBe(400);
  });
});
