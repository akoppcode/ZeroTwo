import type http from "node:http";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer } from "../../src/server.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");

/** Read the SSE stream until a frame with `event: <name>` arrives; return the
 *  accumulated text so the caller can assert on the payload. */
async function readUntilEvent(body: ReadableStream<Uint8Array>, event: string, timeoutMs = 15000): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`event: ${event}`)) return buffer;
    }
  } finally {
    reader.releaseLock();
  }
  return buffer;
}

describe("POST /api/projects/attach/watch (SSE)", () => {
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

  const openWatch = (body: unknown) =>
    fetch(`${baseUrl}/api/projects/attach/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("streams `watching` then `detected` once a PBIR project appears in the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-watch-route-"));
    const dest = join(dir, "sample");
    const res = await openWatch({ destFolder: dest, agent: "claude" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Drop the sample project into the watched folder; the watcher settles and attaches.
    await cp(join(FIXTURES, "sample.pbip"), dest, { recursive: true });
    const stream = await readUntilEvent(res.body!, "detected");
    expect(stream).toContain("event: watching");
    expect(stream).toContain("event: detected");
    expect(stream).toContain('"pageCount":2');
    expect(stream).toContain('"agent":"claude"');
  }, 20000);

  it("validates inputs (400 on missing destFolder / bad agent)", async () => {
    expect((await openWatch({ agent: "claude" })).status).toBe(400);
    expect((await openWatch({ destFolder: "/x", agent: "gpt" })).status).toBe(400);
  });
});
