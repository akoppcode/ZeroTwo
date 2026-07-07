import type http from 'node:http';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  promises as fsp,
  readFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  describeStablePromptCache,
  designSystemIdFromPluginSnapshot,
  resolveChatExtraAllowedDirs,
  resolveEffectiveDesignSystemSelection,
  resolveResearchCommandContract,
  startServer,
} from '../src/server.js';
import { skillCwdAliasSegment } from '../src/cwd-aliases.js';
import { readMemoryConfig, writeMemoryConfig } from '../src/memory.js';
import { upsertMessage } from '../src/db.js';


async function withFakeAgent<T>(
  binName: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'od-chat-route-bin-'));
  const oldPath = process.env.PATH;
  try {
    if (process.platform === 'win32') {
      const runner = join(dir, `${binName}-test-runner.cjs`);
      await fsp.writeFile(runner, script);
      await fsp.writeFile(
        join(dir, `${binName}.cmd`),
        `@echo off\r\nnode "${runner}" %*\r\n`,
      );
    } else {
      const bin = join(dir, binName);
      await fsp.writeFile(bin, `#!/usr/bin/env node\n${script}`);
      await fsp.chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
    killProcessesUsingPath(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function killProcessesUsingPath(pathFragment: string): void {
  if (process.platform === 'win32') return;
  let output = '';
  try {
    output = execFileSync('pgrep', ['-f', pathFragment], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

describe('/api/chat', () => {
  let server: http.Server;
  let baseUrl: string;
  let originalMemoryConfig: Awaited<ReturnType<typeof readMemoryConfig>> | null = null;
  const originalPath = process.env.PATH;
  const originalAgentHome = process.env.OD_AGENT_HOME;
  const tempDirs: string[] = [];

  async function createPluginFixture(args: {
    pluginId: string;
    dirName: string;
    localSkillPath?: string;
  }): Promise<string> {
    const root = await fsp.mkdtemp(join(tmpdir(), 'od-plugin-fixture-'));
    tempDirs.push(root);
    const fixtureDir = resolve(root, args.dirName);
    const baseFixtureDir = resolve(
      process.cwd(),
      'tests',
      'fixtures',
      'plugin-fixtures',
      'sample-plugin',
    );
    await fsp.cp(baseFixtureDir, fixtureDir, { recursive: true });
    const manifestPath = resolve(fixtureDir, 'open-design.json');
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as {
      name: string;
      title: string;
      od?: { context?: { skills?: Array<{ ref?: string; path?: string }> } };
    };
    manifest.name = args.pluginId;
    manifest.title = args.pluginId;
    if (args.localSkillPath) {
      manifest.od ??= {};
      manifest.od.context ??= {};
      manifest.od.context.skills = [{ path: args.localSkillPath }];
    }
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return fixtureDir;
  }

  beforeAll(async () => {
    if (process.env.OD_DATA_DIR) {
      originalMemoryConfig = await readMemoryConfig(process.env.OD_DATA_DIR);
      await writeMemoryConfig(process.env.OD_DATA_DIR, {
        enabled: false,
        extraction: null,
      });
    }
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalAgentHome == null) {
      delete process.env.OD_AGENT_HOME;
    } else {
      process.env.OD_AGENT_HOME = originalAgentHome;
    }
  });

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.env.OD_DATA_DIR && originalMemoryConfig) {
      await writeMemoryConfig(process.env.OD_DATA_DIR, {
        enabled: originalMemoryConfig.enabled,
        extraction: originalMemoryConfig.extraction,
      });
    }
  });

  it('does not reference an out-of-scope response while starting a run', async () => {
    process.env.PATH = '';
    const emptyAgentHome = mkdtempSync(join(tmpdir(), 'od-empty-agent-home-'));
    tempDirs.push(emptyAgentHome);
    process.env.OD_AGENT_HOME = emptyAgentHome;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'claude',
        message: 'hello',
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).not.toContain('res is not defined');
    expect(body).toContain('AGENT_UNAVAILABLE');
  });


  it('reuses an existing assistant message row instead of creating a duplicate when assistantMessageId is supplied', async () => {
    if (!process.env.OD_DATA_DIR) {
      throw new Error('OD_DATA_DIR is required for assistant message reuse tests');
    }
    const projectId = `proj-${randomUUID()}`;
    const assistantMessageId = `assistant-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Assistant row reuse fixture' }),
    });
    expect(createProjectResponse.ok).toBe(true);

    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.ok).toBe(true);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const dbFile = resolve(process.env.OD_DATA_DIR, 'app.sqlite');
    const sqlite = new Database(dbFile);
    try {
      upsertMessage(sqlite as never, conversationId!, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        runStatus: 'failed',
        startedAt: Date.now() - 1_000,
        endedAt: Date.now() - 500,
      });
    } finally {
      sqlite.close();
    }

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'reused-assistant-row-ok' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            assistantMessageId,
            message: 'retry this turn',
          }),
        });
        const body = await response.text();
        expect(response.ok).toBe(true);
        expect(body).toContain('reused-assistant-row-ok');
      },
    );

    const verifyDb = new Database(dbFile, { readonly: true });
    try {
      const rows = verifyDb
        .prepare(`SELECT id, content, run_id FROM messages WHERE conversation_id = ? AND role = 'assistant'`)
        .all(conversationId) as Array<{ id: string; content: string; run_id: string | null }>;
      expect(rows.filter((row) => row.id === assistantMessageId)).toHaveLength(1);
      expect(rows.some((row) => row.id !== assistantMessageId && row.content.includes('reused-assistant-row-ok'))).toBe(false);
      const reused = rows.find((row) => row.id === assistantMessageId);
      expect(reused?.content).toContain('reused-assistant-row-ok');
    } finally {
      verifyDb.close();
    }
  });

  it('allows plugin authoring to succeed when the requested generated-plugin artifacts exist before close', async () => {
    const projectId = `proj-plugin-authoring-success-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring artifact success fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
const fs = require('node:fs');
const path = require('node:path');
process.stdin.resume();
process.stdin.on('end', () => {
  const pluginDir = path.join(process.cwd(), 'generated-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'open-design.json'), JSON.stringify({ name: 'generated-plugin' }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'SKILL.md'), '# Generated plugin\\n');
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '我来帮你创建一个通用的 Open Design 插件脚手架。先读取文档规范，再生成插件文件。' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '请创建一个可刷新、可审计、由 API 驱动的 Open Design 插件脚手架。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('先读取文档规范，再生成插件文件');
        expect(statusBody.status).toBe('succeeded');

        const filesResponse = await fetch(`${baseUrl}/api/projects/${projectId}/files`);
        expect(filesResponse.status).toBe(200);
        const filesBody = await filesResponse.json() as { files: Array<{ name: string }> };
        expect(filesBody.files.some((file) => file.name === 'generated-plugin/open-design.json')).toBe(true);
        expect(filesBody.files.some((file) => file.name === 'generated-plugin/SKILL.md')).toBe(true);
      },
    );
  });

  it('does not report plugin authoring as succeeded when the agent only emits planning text without artifacts', async () => {
    const projectId = `proj-plugin-authoring-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring completion fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '我来帮你创建一个通用的 Open Design 插件脚手架。先读取文档规范，再生成插件文件。' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '请创建一个可刷新、可审计、由 API 驱动的 Open Design 插件脚手架。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const {
          runId,
          pluginId,
          appliedPluginSnapshotId,
        } = await createResponse.json() as {
          runId: string;
          pluginId: string | null;
          appliedPluginSnapshotId: string | null;
        };
        expect(pluginId).toBe('od-plugin-authoring');
        expect(appliedPluginSnapshotId).toBeTruthy();

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('先读取文档规范，再生成插件文件');
        expect(statusBody.status).not.toBe('succeeded');

        const filesResponse = await fetch(`${baseUrl}/api/projects/${projectId}/files`);
        expect(filesResponse.status).toBe(200);
        const filesBody = await filesResponse.json() as { files: Array<{ name: string }> };
        expect(filesBody.files.some((file) => file.name.startsWith('generated-plugin/'))).toBe(false);
      },
    );
  });
  it('does not fail plugin authoring when the turn-1 reply is a clarifying question-form awaiting the brief', async () => {
    // The `od-plugin-authoring` plugin's turn-1 flow is to emit a
    // `<question-form>` collecting the plugin brief, then STOP and wait for
    // the user to answer — artifacts only land on the follow-up turn. The
    // missing-artifacts guard must not treat that expected pause as a
    // failure (regression: "Plugin authoring ended before generating the
    // required generated-plugin artifacts.").
    const projectId = `proj-plugin-authoring-question-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring question-form fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '先确认几个问题再开始搭建。\\n<question-form id="discovery" title="Plugin brief">\\n{"questions":[{"id":"purpose","label":"What should it do?","type":"text"}]}\\n</question-form>' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '帮我做个插件。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('<question-form');
        expect(eventsBody).not.toContain('ended before generating the required generated-plugin artifacts');
        expect(statusBody.status).toBe('succeeded');
      },
    );
  });
  it('does not fail plugin authoring when the clarifying form uses the <ask-question> alias', async () => {
    // `<ask-question>` is the alias the web form parser accepts alongside
    // the canonical `<question-form>` (apps/web/src/artifacts/question-form.ts).
    // Models sometimes drift to it; the UI still renders a valid brief form,
    // so the daemon's missing-artifacts guard must recognize the alias too —
    // otherwise the same "ended before generating…" regression returns for a
    // supported clarification shape.
    const projectId = `proj-plugin-authoring-alias-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring ask-question alias fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '先确认几个问题再开始搭建。\\n<ask-question id="discovery" title="Plugin brief">\\n{"questions":[{"id":"purpose","label":"What should it do?","type":"text"}]}\\n</ask-question>' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '帮我做个插件。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('<ask-question');
        expect(eventsBody).not.toContain('ended before generating the required generated-plugin artifacts');
        expect(statusBody.status).toBe('succeeded');
      },
    );
  });
  it('still fails plugin authoring when a question-form tag wraps a non-renderable (non-JSON) body', async () => {
    // The clarification carve-out must match the web parser's renderable-form
    // contract (JSON body with a `questions` array), not just the opening
    // tag. A `<question-form>` whose body is not valid form JSON renders as
    // raw prose in the UI — no usable brief card — so suppressing the
    // missing-artifacts failure for it would turn a hard failure into a false
    // success. This pins that the guard stays gated on a renderable body.
    const projectId = `proj-plugin-authoring-badform-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring malformed-form fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '先确认几个问题。\\n<question-form id="discovery">\\nWhat should it do? (free text)\\n</question-form>' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '帮我做个插件。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('ended before generating the required generated-plugin artifacts');
        expect(statusBody.status).not.toBe('succeeded');
      },
    );
  });
  it('does not fail plugin authoring when a valid form follows a Unicode preamble that expands under toLowerCase', async () => {
    // The mirrored close-tag scan must stay in the original-string coordinate
    // space. Some code points expand under toLowerCase ("İ" -> "i̇"), so
    // lowercasing the whole buffer before indexing would desync the close-tag
    // offset and corrupt the JSON body slice, failing a valid form. The
    // preamble here contains "İ" before a well-formed form block.
    const projectId = `proj-plugin-authoring-unicode-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin authoring unicode-preamble fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createProjectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.status).toBe(200);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'İstanbul brief — 先确认几个问题。\\n<ask-question id="discovery" title="Plugin brief">\\n{"questions":[{"id":"purpose","label":"What should it do?","type":"text"}]}\\n</ask-question>' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            pluginId: 'od-plugin-authoring',
            message: '帮我做个插件。',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const eventsBody = await readSseUntil(eventsResponse, 'event: final');
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).not.toContain('ended before generating the required generated-plugin artifacts');
        expect(statusBody.status).toBe('succeeded');
      },
    );
  });
  it('closes the # Instructions block with an explicit "do not echo" guard so models do not parrot the prompt back', async () => {
    // claude-opus-4-7 (and a few other instruction-tuned models) start
    // their reply by echoing the # Instructions block verbatim, which
    // shows up to users as the system prompt leading the visible
    // answer. server.ts:9934 closes every Instructions block with a
    // trailing guard line; this test pins the literal so a future
    // refactor cannot silently drop it.
    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('Do not quote, restate, or echo the # Instructions block above')
      ? 'has-echo-guard'
      : 'missing-echo-guard',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            message: 'hello',
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('has-echo-guard');
        expect(body).not.toContain('missing-echo-guard');
      },
    );
  });

  it('injects @-mention skillIds into the composed system prompt', async () => {
    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('## Composed skill — faq-page') ? 'has-composed-skill-header' : 'missing-composed-skill-header',
    prompt.includes('# FAQ Page Skill') ? 'has-faq-skill-body' : 'missing-faq-skill-body',
    prompt.includes('category filtering') ? 'has-faq-skill-content' : 'missing-faq-skill-content',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            message: 'build an faq page',
            skillIds: ['faq-page'],
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('has-composed-skill-header');
        expect(body).toContain('has-faq-skill-body');
        expect(body).toContain('has-faq-skill-content');
        expect(body).not.toContain('missing-composed-skill-header');
        expect(body).not.toContain('missing-faq-skill-body');
        expect(body).not.toContain('missing-faq-skill-content');
      },
    );
  });

  it('stages ad-hoc skill side files into the project cwd', async () => {
    const projectId = `project-${randomUUID()}`;
    const stagedRelativePath = `.od-skills/${skillCwdAliasSegment(resolve(process.cwd(), '..', '..', 'skills', 'release-notes-one-pager'))}/references/checklist.md`;
    const expectedChecklist = await fsp.readFile(
      resolve(process.cwd(), '..', '..', 'skills', 'release-notes-one-pager', 'references', 'checklist.md'),
      'utf8',
    );

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Ad hoc staged skill project',
      }),
    });

    expect(createProjectResponse.ok).toBe(true);

    const fakeAgentScript = `
const fs = require('node:fs');
const stagedChecklist = fs.readFileSync(${JSON.stringify(stagedRelativePath)}, 'utf8');
if (stagedChecklist !== ${JSON.stringify(expectedChecklist)}) {
  console.error('staged-skill-side-files-mismatch');
  process.exit(1);
}
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'staged-skill-side-files-before-spawn' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`;

    await withFakeAgent(
      'copilot',
      fakeAgentScript,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            message: 'draft the release notes',
            skillIds: ['release-notes-one-pager'],
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('staged-skill-side-files-before-spawn');
      },
    );

    const stagedFileResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/raw/${stagedRelativePath}`,
    );
    const stagedFileBody = await stagedFileResponse.text();

    expect(stagedFileResponse.ok).toBe(true);
    expect(stagedFileBody).toBe(expectedChecklist);
  });

  it('stages side files for every composed skill into the project cwd', async () => {
    const projectId = `project-${randomUUID()}`;
    const stagedPaths = [
      `.od-skills/${skillCwdAliasSegment(resolve(process.cwd(), '..', '..', 'skills', 'release-notes-one-pager'))}/references/checklist.md`,
      `.od-skills/${skillCwdAliasSegment(resolve(process.cwd(), '..', '..', 'skills', 'swiss-creative-mode-template'))}/references/checklist.md`,
    ] as const;
    const expectedBodies = await Promise.all(
      [
        resolve(process.cwd(), '..', '..', 'skills', 'release-notes-one-pager', 'references', 'checklist.md'),
        resolve(process.cwd(), '..', '..', 'skills', 'swiss-creative-mode-template', 'references', 'checklist.md'),
      ].map((file) => fsp.readFile(file, 'utf8')),
    );

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Multi staged skill project',
      }),
    });

    expect(createProjectResponse.ok).toBe(true);

    const fakeAgentScript = `
const fs = require('node:fs');
const stagedBodies = [
  fs.readFileSync(${JSON.stringify(stagedPaths[0])}, 'utf8'),
  fs.readFileSync(${JSON.stringify(stagedPaths[1])}, 'utf8'),
];
const expectedBodies = ${JSON.stringify(expectedBodies)};
if (JSON.stringify(stagedBodies) !== JSON.stringify(expectedBodies)) {
  console.error('multi-staged-skill-side-files-mismatch');
  process.exit(1);
}
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'multi-staged-skill-side-files-before-spawn' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`;

    await withFakeAgent(
      'copilot',
      fakeAgentScript,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            message: 'compose multiple skills',
            skillIds: ['release-notes-one-pager', 'swiss-creative-mode-template'],
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('multi-staged-skill-side-files-before-spawn');
      },
    );
  });

  it('propagates ad-hoc skill critique policy into the chat resolver', async () => {
    if (!process.env.OD_DATA_DIR) {
      throw new Error('OD_DATA_DIR is required for user skill critique-policy tests');
    }

    const skillId = `critique-opt-out-${randomUUID()}`;
    const skillDir = resolve(process.env.OD_DATA_DIR, 'skills', skillId);
    const originalCritiqueEnabled = process.env.OD_CRITIQUE_ENABLED;

    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      resolve(skillDir, 'SKILL.md'),
      `---
name: ${skillId}
description: Ad-hoc critique opt-out regression fixture.
od:
  critique:
    policy: opt-out
---

# Critique opt-out fixture

This skill should suppress critique when selected through skillIds.
`,
      'utf8',
    );

    process.env.OD_CRITIQUE_ENABLED = 'true';

    try {
      await withFakeAgent(
        'copilot',
        `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('## Composed skill — ${skillId}') ? 'has-opt-out-skill-header' : 'missing-opt-out-skill-header',
    prompt.includes('<CRITIQUE_RUN') ? 'unexpected-critique-panel' : 'critique-panel-disabled-by-skill-policy',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
        async () => {
          const response = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              designSystemId: 'default',
              message: 'draft an opt-out skill artifact',
              skillIds: [skillId],
            }),
          });
          const body = await response.text();

          expect(response.ok).toBe(true);
          expect(body).toContain('has-opt-out-skill-header');
          expect(body).toContain('critique-panel-disabled-by-skill-policy');
          expect(body).not.toContain('missing-opt-out-skill-header');
          expect(body).not.toContain('unexpected-critique-panel');
        },
      );
    } finally {
      if (originalCritiqueEnabled == null) {
        delete process.env.OD_CRITIQUE_ENABLED;
      } else {
        process.env.OD_CRITIQUE_ENABLED = originalCritiqueEnabled;
      }
      await fsp.rm(skillDir, { recursive: true, force: true });
    }
  });

  it('preserves plugin-local and composed @-mention skills in plugin-bound runs', async () => {
    const pluginId = `plugin-local-${randomUUID()}`;
    const pluginFixtureDir = await createPluginFixture({
      pluginId,
      dirName: `plugin-local-${randomUUID()}`,
      localSkillPath: './SKILL.md',
    });
    const installResponse = await fetch(`${baseUrl}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ source: pluginFixtureDir }),
    });
    const installBody = await installResponse.text();

    expect(installResponse.status).toBe(200);
    expect(installBody).toContain(`"id":"${pluginId}"`);

    const projectId = `project-${randomUUID()}`;
    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Plugin-bound skill composition project',
        pluginId,
        pluginInputs: { topic: 'agentic design' },
      }),
    });
    const createProjectBody = await createProjectResponse.json() as {
      appliedPluginSnapshotId?: string;
    };

    expect(createProjectResponse.ok).toBe(true);
    expect(createProjectBody.appliedPluginSnapshotId).toBeTruthy();

    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('# Sample Plugin') ? 'has-plugin-skill-body' : 'missing-plugin-skill-body',
    prompt.includes('## Composed skill — faq-page') ? 'has-composed-skill-header' : 'missing-composed-skill-header',
    prompt.includes('# FAQ Page Skill') ? 'has-composed-skill-body' : 'missing-composed-skill-body',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            message: 'build a plugin-backed faq page',
            appliedPluginSnapshotId: createProjectBody.appliedPluginSnapshotId,
            skillIds: ['faq-page'],
          }),
        });
        const createRunBody = await createRunResponse.json() as { runId: string };

        expect(createRunResponse.status).toBe(202);

        const eventsResponse = await fetch(`${baseUrl}/api/runs/${createRunBody.runId}/events`);
        const body = await readSseUntil(eventsResponse, 'event: final');

        expect(body).toContain('has-plugin-skill-body');
        expect(body).toContain('has-composed-skill-header');
        expect(body).toContain('has-composed-skill-body');
        expect(body).not.toContain('missing-plugin-skill-body');
        expect(body).not.toContain('missing-composed-skill-header');
        expect(body).not.toContain('missing-composed-skill-body');
      },
    );
  });

  it('stages colliding plugin and composed skill dirs under distinct aliases', async () => {
    if (!process.env.OD_DATA_DIR) {
      throw new Error('OD_DATA_DIR is required for colliding skill-dir staging tests');
    }

    const pluginId = `plugin-collision-${randomUUID()}`;
    const pluginFixtureDir = await createPluginFixture({
      pluginId,
      dirName: 'sample-plugin',
      localSkillPath: './SKILL.md',
    });
    const installResponse = await fetch(`${baseUrl}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ source: pluginFixtureDir }),
    });
    const installBody = await installResponse.text();

    expect(installResponse.status).toBe(200);
    expect(installBody).toContain(`"id":"${pluginId}"`);

    const projectId = `project-${randomUUID()}`;
    const userSkillDir = resolve(process.env.OD_DATA_DIR, 'skills', 'sample-plugin');
    const userChecklist = 'user-skill-checklist';
    const userAlias = skillCwdAliasSegment(userSkillDir);

    await fsp.mkdir(resolve(userSkillDir, 'references'), { recursive: true });
    await fsp.writeFile(
      resolve(userSkillDir, 'SKILL.md'),
      '# Sample-plugin side-file fixture\n\nRead references/checklist.md before drafting.',
      'utf8',
    );
    await fsp.writeFile(resolve(userSkillDir, 'references', 'checklist.md'), userChecklist, 'utf8');

    try {
      const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Colliding skill-dir project',
          pluginId,
          pluginInputs: { topic: 'agentic design' },
        }),
      });
      const createProjectBody = await createProjectResponse.json() as {
        appliedPluginSnapshotId?: string;
      };
      const installedPluginResponse = await fetch(`${baseUrl}/api/plugins/${pluginId}`);
      const installedPluginBody = await installedPluginResponse.json() as { fsPath: string };
      const pluginAlias = skillCwdAliasSegment(installedPluginBody.fsPath);

      expect(createProjectResponse.ok).toBe(true);
      expect(installedPluginResponse.ok).toBe(true);
      expect(createProjectBody.appliedPluginSnapshotId).toBeTruthy();
      expect(pluginAlias).not.toBe(userAlias);

      await withFakeAgent(
        'copilot',
        `
const fs = require('node:fs');
const pluginSkill = fs.readFileSync(${JSON.stringify(`.od-skills/${pluginAlias}/SKILL.md`)}, 'utf8');
const userChecklist = fs.readFileSync(${JSON.stringify(`.od-skills/${userAlias}/references/checklist.md`)}, 'utf8');
if (!pluginSkill.includes('# Sample Plugin')) {
  console.error('plugin-skill-stage-missing');
  process.exit(1);
}
if (userChecklist !== ${JSON.stringify(userChecklist)}) {
  console.error('colliding-skill-stage-mismatch');
  process.exit(1);
}
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'colliding-skill-dirs-staged' } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
        async () => {
          const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              projectId,
              message: 'use both plugin and user skill side files',
              appliedPluginSnapshotId: createProjectBody.appliedPluginSnapshotId,
              skillIds: ['sample-plugin'],
            }),
          });
          const createRunBody = await createRunResponse.json() as { runId: string };

          expect(createRunResponse.status).toBe(202);

          const eventsResponse = await fetch(`${baseUrl}/api/runs/${createRunBody.runId}/events`);
          const body = await readSseUntil(eventsResponse, 'event: final');

          expect(body).toContain('colliding-skill-dirs-staged');
        },
      );
    } finally {
      await fsp.rm(userSkillDir, { recursive: true, force: true });
    }
  });

  it('canonicalizes aliased skill ids before deduping composed skills', async () => {
    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const hasDuplicateComposedAlias = prompt.includes('## Composed skill — open-design-landing');
  const checks = [
    hasDuplicateComposedAlias ? 'duplicate-alias-composed-skill' : 'deduped-alias-composed-skill',
    prompt.includes('# open-design-landing') ? 'has-base-alias-skill-body' : 'missing-base-alias-skill-body',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            message: 'build the Open Design landing page',
            skillId: 'editorial-collage',
            skillIds: ['open-design-landing'],
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('deduped-alias-composed-skill');
        expect(body).toContain('has-base-alias-skill-body');
        expect(body).not.toContain('duplicate-alias-composed-skill');
        expect(body).not.toContain('missing-base-alias-skill-body');
      },
    );
  });

  it('fails stalled json-stream runs after the inactivity timeout elapses', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '500';
    try {
      await withFakeAgent(
        'copilot',
        `
console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const eventsController = new AbortController();
          const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
            signal: eventsController.signal,
          });
          const eventsBody = await readSseUntil(eventsResponse, 'event: error');
          eventsController.abort();
          const statusBody = await waitForRunStatus(baseUrl, runId);

          expect(eventsBody).toContain('event: error');
          expect(eventsBody).toContain('Agent stalled without emitting any new output');
          expect(eventsBody).toContain('Phase details: spawned agent copilot;');
          expect(eventsBody).not.toContain('spawned agent binary');
          expect(eventsBody).toMatch(/stdout arrived: (yes|no)/);
          expect(statusBody.status).toBe('failed');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('keeps Claude stream runs alive while structured output is still flowing', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '3000';
    try {
      await withFakeAgent(
        'claude',
        `
const lines = [
  JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' }, ttft_ms: 10 } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, duration_ms: 700, stop_reason: 'end_turn' }),
];
let index = 0;
console.log(lines[index++]);
const timer = setInterval(() => {
  if (index >= lines.length) {
    clearInterval(timer);
    process.exit(0);
    return;
  }
  console.log(lines[index++]);
}, 750);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'claude',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const statusBody = await waitForRunStatus(baseUrl, runId);
          expect(statusBody.status).toBe('succeeded');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('surfaces Claude auth diagnostics through the SSE error channel', async () => {
    await withFakeAgent(
      'claude',
      `
console.error(JSON.stringify({ apiKeySource: 'none', error_status: 401 }));
process.exit(1);
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'claude',
            message: 'hello',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsController = new AbortController();
        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
          signal: eventsController.signal,
        });
        const eventsBody = await readSseUntil(eventsResponse, 'event: error');
        eventsController.abort();
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('event: error');
        expect(eventsBody).toContain('/login');
        expect(eventsBody).toContain('CLAUDE_CONFIG_DIR');
        expect(statusBody.status).toBe('failed');
      },
    );
  });

  it('caps oversized inactivity overrides so Node does not fire the timer immediately', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '10000000000';
    try {
      await withFakeAgent(
        'copilot',
        `
setTimeout(() => {
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'done' } }));
  process.exit(0);
}, 50);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const statusBody = await waitForRunStatus(baseUrl, runId);
          expect(statusBody.status).toBe('succeeded');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('marks stalled runs failed even when the child ignores SIGTERM', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '500';
    try {
      await withFakeAgent(
        'copilot',
        `
console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const eventsController = new AbortController();
          const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
            signal: eventsController.signal,
          });
          const eventsBody = await readSseUntil(eventsResponse, 'event: error');
          eventsController.abort();
          const statusBody = await waitForRunStatus(baseUrl, runId);

          expect(eventsBody).toContain('Agent stalled without emitting any new output');
          expect(statusBody.status).toBe('failed');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('marks submitted discovery form answers as the active turn before the transcript', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'od-form-answer-prompt-'));
    tempDirs.push(captureDir);
    const capturePath = join(captureDir, 'prompt.txt');
    const previousCapturePath = process.env.OD_CAPTURE_PROMPT_PATH;
    process.env.OD_CAPTURE_PROMPT_PATH = capturePath;
    try {
      await withFakeAgent(
        'copilot',
        `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.OD_CAPTURE_PROMPT_PATH, input, 'utf8');
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'building now' } }));
});
`,
        async () => {
          const formAnswers = [
            '[form answers — discovery]',
            '- output: Dashboard / tool UI',
            '- brand: Pick a direction for me [value: pick_direction]',
          ].join('\n');
          const transcript = [
            '## user',
            'Design a metrics dashboard.',
            '',
            '## assistant',
            '<question-form id="discovery" title="Quick brief — 30 seconds"></question-form>',
            '',
            '## user',
            formAnswers,
          ].join('\n');

          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'copilot',
              message: transcript,
              currentPrompt: formAnswers,
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };
          const statusBody = await waitForRunStatus(baseUrl, runId);

          expect(statusBody.status).toBe('succeeded');
          expect(existsSync(capturePath)).toBe(true);
          const prompt = readFileSync(capturePath, 'utf8');
          const transitionIdx = prompt.indexOf('## Latest user turn - form answers submitted');
          const transcriptIdx = prompt.indexOf('## Full conversation transcript');
          expect(transitionIdx).toBeGreaterThan(-1);
          expect(transcriptIdx).toBeGreaterThan(transitionIdx);
          expect(prompt).toContain('The user has answered the discovery form. Do not emit another discovery form.');
          expect(prompt).toContain('Continue with RULE 2 / RULE 3 now.');
          expect(prompt).toContain(formAnswers);
        },
      );
    } finally {
      if (previousCapturePath == null) {
        delete process.env.OD_CAPTURE_PROMPT_PATH;
      } else {
        process.env.OD_CAPTURE_PROMPT_PATH = previousCapturePath;
      }
    }
  });

  it('uses a project design system in sandboxed chat runs without an explicit run designSystemId', async () => {
    const projectId = `project-ds-${randomUUID()}`;
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Project DS fixture',
        designSystemId: 'default',
        skipDiscoveryBrief: true,
      }),
    });
    expect(projectResponse.ok).toBe(true);

    const conversationId = `conv-${randomUUID()}`;
    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('## Active design system') ? 'has-active-design-system' : 'missing-active-design-system',
    prompt.includes('Treat the following DESIGN.md as authoritative') ? 'has-design-system-contract' : 'missing-design-system-contract',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            message: 'draft a branded artifact',
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('has-active-design-system');
        expect(body).toContain('has-design-system-contract');
        expect(body).not.toContain('missing-active-design-system');
        expect(body).not.toContain('missing-design-system-contract');

        const runsResponse = await fetch(
          `${baseUrl}/api/runs?conversationId=${encodeURIComponent(conversationId)}`,
        );
        const runsBody = await runsResponse.json() as {
          runs: Array<{
            designSystemId: string | null;
            designSystemRequestedId: string | null;
            designSystemSelectionSource: string | null;
            designSystemDigest: string | null;
            promptCache?: { hit: boolean; missReason: string | null };
          }>;
        };
        expect(runsBody.runs).toHaveLength(1);
        expect(runsBody.runs[0]).toMatchObject({
          designSystemId: 'default',
          designSystemRequestedId: 'default',
          designSystemSelectionSource: 'project',
          promptCache: { hit: false, missReason: 'new-session' },
        });
        expect(runsBody.runs[0]?.designSystemDigest).toMatch(/^[a-f0-9]{64}$/);
      },
    );
  });

  it('keeps requested design systems separate from missing injected design systems', async () => {
    const missingDesignSystemId = `missing-ds-${randomUUID()}`;
    const projectId = `project-missing-ds-${randomUUID()}`;
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Missing project DS fixture',
        skipDiscoveryBrief: true,
      }),
    });
    expect(projectResponse.ok).toBe(true);

    const conversationId = `conv-${randomUUID()}`;
    await withFakeAgent(
      'copilot',
      `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const checks = [
    prompt.includes('## Active design system') ? 'has-active-design-system' : 'missing-active-design-system',
    prompt.includes('Treat the following DESIGN.md as authoritative') ? 'has-design-system-contract' : 'missing-design-system-contract',
  ];
  console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} }));
  console.log(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: checks.join('\\n') } }));
  console.log(JSON.stringify({ type: 'result', success: true, usage: {} }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'copilot',
            projectId,
            conversationId,
            designSystemId: missingDesignSystemId,
            message: 'draft a branded artifact',
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('missing-design-system-contract');
        expect(body).not.toContain('has-design-system-contract');

        const runsResponse = await fetch(
          `${baseUrl}/api/runs?conversationId=${encodeURIComponent(conversationId)}`,
        );
        const runsBody = await runsResponse.json() as {
          runs: Array<{
            designSystemId: string | null;
            designSystemRequestedId: string | null;
            designSystemSelectionSource: string | null;
            designSystemDigest: string | null;
          }>;
        };
        expect(runsBody.runs).toHaveLength(1);
        expect(runsBody.runs[0]).toMatchObject({
          designSystemId: null,
          designSystemRequestedId: missingDesignSystemId,
          designSystemSelectionSource: 'none',
          designSystemDigest: null,
        });
      },
    );
  });
});

describe('daemon run creation during shutdown', () => {
  it('rejects new run creation while shutdown cleanup is still in flight', async () => {
    const previousGrace = process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS;
    process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS = '100';
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown: () => Promise<void>;
    };
    try {
      await withFakeAgent(
        'copilot',
        `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
        async () => {
          const activeResponse = await fetch(`${started.url}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'copilot', message: 'hello' }),
          });
          expect(activeResponse.status).toBe(202);
          const { runId } = await activeResponse.json() as { runId: string };
          await waitForRunStatus(started.url, runId, (status) => status === 'running');

          const shutdownPromise = started.shutdown();

          const runResponse = await fetch(`${started.url}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'copilot', message: 'late run' }),
          });
          const chatResponse = await fetch(`${started.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'copilot', message: 'late chat' }),
          });

          expect(runResponse.status).toBe(503);
          expect(chatResponse.status).toBe(503);
          await shutdownPromise;
        },
      );
    } finally {
      if (previousGrace == null) {
        delete process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS;
      } else {
        process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS = previousGrace;
      }
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});

async function readSseUntil(response: Response, marker: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { done, value } = await reader.read();
    if (done) return body;
    body += decoder.decode(value, { stream: true });
    if (body.includes(marker)) return body;
  }
  return body;
}

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
  done: (status: string) => boolean = (status) => status !== 'queued' && status !== 'running',
): Promise<{ status: string }> {
  let lastStatus = 'unknown';
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const statusResponse = await fetch(`${baseUrl}/api/runs/${runId}`);
    const statusBody = await statusResponse.json() as { status: string };
    lastStatus = statusBody.status;
    if (done(statusBody.status)) return statusBody;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not reach expected status; last status: ${lastStatus}`);
}

describe('chat prompt helpers', () => {
  it('defaults enabled research without an explicit query to the current message', () => {
    const prompt = resolveResearchCommandContract(
      { enabled: true },
      'EV market 2025 trends',
    );

    expect(prompt).toContain('Canonical query for this run:');
    expect(prompt).toContain('EV market 2025 trends');
    expect(prompt).toContain('the first tool action must be the research command');
  });

  it('resolves design-system selection precedence for run prompt composition', () => {
    expect(resolveEffectiveDesignSystemSelection({
      requestDesignSystemId: 'request-ds',
      pluginDesignSystemId: 'plugin-ds',
      projectDesignSystemId: 'project-ds',
      appDefaultDesignSystemId: 'default-ds',
    })).toEqual({ id: 'request-ds', source: 'request' });

    expect(resolveEffectiveDesignSystemSelection({
      pluginDesignSystemId: 'plugin-ds',
      projectDesignSystemId: 'project-ds',
      appDefaultDesignSystemId: 'default-ds',
    })).toEqual({ id: 'plugin-ds', source: 'plugin' });

    expect(resolveEffectiveDesignSystemSelection({
      projectDesignSystemId: 'project-ds',
      appDefaultDesignSystemId: 'default-ds',
    })).toEqual({ id: 'project-ds', source: 'project' });

    expect(resolveEffectiveDesignSystemSelection({
      appDefaultDesignSystemId: 'default-ds',
    })).toEqual({ id: 'default-ds', source: 'app-default' });

    expect(resolveEffectiveDesignSystemSelection({
      appDefaultDesignSystemId: 'default-ds',
      allowAppDefault: false,
    })).toEqual({ id: null, source: 'none' });
  });

  it('extracts the primary design-system id from a plugin snapshot', () => {
    expect(designSystemIdFromPluginSnapshot({
      resolvedContext: {
        items: [
          { kind: 'skill', id: 'landing' },
          { kind: 'design-system', id: 'secondary' },
          { kind: 'design-system', id: 'primary', primary: true },
        ],
      },
    })).toBe('primary');

    expect(designSystemIdFromPluginSnapshot({
      resolvedContext: {
        items: [
          { kind: 'design-system', id: 'fallback' },
        ],
      },
    })).toBe('fallback');

    expect(designSystemIdFromPluginSnapshot({ resolvedContext: { items: [] } })).toBeNull();
  });

  it('describes stable prompt cache hits and miss reasons', () => {
    expect(describeStablePromptCache({
      isResuming: false,
      storedStablePromptHash: null,
      currentStableHash: 'hash-a',
    })).toEqual({
      stablePromptHash: 'hash-a',
      hit: false,
      missReason: 'new-session',
    });

    expect(describeStablePromptCache({
      isResuming: true,
      storedStablePromptHash: 'hash-a',
      currentStableHash: 'hash-a',
    })).toEqual({
      stablePromptHash: 'hash-a',
      hit: true,
      missReason: null,
    });

    expect(describeStablePromptCache({
      isResuming: true,
      storedStablePromptHash: 'hash-a',
      currentStableHash: 'hash-b',
    })).toEqual({
      stablePromptHash: 'hash-b',
      hit: false,
      missReason: 'stable-prompt-changed',
    });
  });

  it('keeps resource and linked dirs that exist on disk', () => {
    const existingDirs = new Set([
      '/repo/skills',
      '/repo/design-systems',
      '/linked/reference',
    ]);
    const dirs = resolveChatExtraAllowedDirs({
      skillsDir: '/repo/skills',
      designSystemsDir: '/repo/design-systems',
      linkedDirs: ['/linked/reference', '/linked/missing'],
      existsSync: (dir: string) => existingDirs.has(dir),
    });

    expect(dirs).toEqual([
      '/repo/skills',
      '/repo/design-systems',
      '/linked/reference',
    ]);
  });
});
