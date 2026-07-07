import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineConnectorTool, type ConnectorCatalogDefinition } from '../src/connectors/catalog.js';
import type { ConnectorService } from '../src/connectors/service.js';
import {
  extractMemoryFromConnectors,
  suggestMemoryFromConnectors,
} from '../src/memory-connectors.js';
import { memoryDir, readMemoryEntry, writeMemoryConfig } from '../src/memory.js';
import {
  __resetExtractionsForTests,
  listExtractions,
} from '../src/memory-extractions.js';

const dataDir = path.join(process.env.OD_DATA_DIR ?? process.cwd(), 'memory-connectors-test');
const originalFetch = globalThis.fetch;

// Connector memory extraction now runs exclusively through the chat Local CLI
// (Claude Code) — the BYOK/OpenAI API-key extraction protocol was removed. Kept
// tests drive that path with a stub runner that returns the model's JSON, in
// place of the old global fetch mock.
const DEFAULT_MEMORY_ENTRIES_JSON = JSON.stringify({
  entries: [
    {
      type: 'project',
      name: 'OpenDesign design memory',
      description: 'Connector memories should stay design-related',
      body: 'OpenDesign connector memories should focus on design preferences, UI decisions, and visual references rather than generic app activity.',
    },
  ],
});

function memoryCliRunner(payload: string = DEFAULT_MEMORY_ENTRIES_JSON) {
  return vi.fn(async (_input: { system?: string; user?: string }) => payload);
}

const notionDefinition: ConnectorCatalogDefinition = {
  id: 'notion',
  name: 'Notion',
  provider: 'composio',
  category: 'Productivity',
  description: 'Search and read Notion pages.',
  authentication: 'composio',
  tools: [
    defineConnectorTool({
      name: 'notion.notion_search',
      providerToolId: 'NOTION_SEARCH',
      title: 'Search Notion',
      description: 'Search Notion pages and databases.',
      inputSchemaJson: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
      curation: {
        useCases: ['personal_daily_digest'],
        reason: 'Searches the workspace for personal context.',
      },
    }),
  ],
  allowedToolNames: ['notion.notion_search'],
  curatedToolNames: ['notion.notion_search'],
  minimumApproval: 'auto',
};

function createNotionService(
  executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [],
): ConnectorService {
  return {
    listFastDefinitions: () => [notionDefinition],
    listConnectorStatuses: () => ({
      notion: { status: 'connected', accountLabel: 'Product wiki' },
    }),
    getStatus: () => ({ status: 'connected', accountLabel: 'Product wiki' }),
    execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
      executeCalls.push(request);
      return {
        ok: true,
        connectorId: request.connectorId,
        accountLabel: 'Product wiki',
        toolName: request.toolName,
        safety: notionDefinition.tools[0]!.safety,
        outputSummary: 'Found OpenDesign design memory notes in Notion.',
        output: {
          pages: [
            {
              title: 'OpenDesign memory plan',
              text: 'OpenDesign connector memory should collect design preferences, UI decisions, and visual references from Notion.',
            },
          ],
        },
      };
    },
  } as unknown as ConnectorService;
}

describe('connector memory extraction', () => {
  beforeEach(async () => {
    await fsp.rm(memoryDir(dataDir), { recursive: true, force: true });
    __resetExtractionsForTests();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entries: [
                {
                  type: 'project',
                  name: 'OpenDesign design memory',
                  description: 'Connector memories should stay design-related',
                  body: 'OpenDesign connector memories should focus on design preferences, UI decisions, and visual references rather than generic app activity.',
                },
              ],
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await writeMemoryConfig(dataDir, {
      extraction: {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reads connected app context and returns reviewable memory suggestions', async () => {
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = createNotionService(executeCalls);

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    expect(result.attemptedLLM).toBe(true);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        id: 'project_opendesign_design_memory_1',
        type: 'project',
        name: 'OpenDesign design memory',
        source: expect.objectContaining({
          kind: 'connector',
          connectorId: 'notion',
          connectorName: 'Notion',
        }),
      }),
    ]);
    expect(executeCalls).toEqual([
      expect.objectContaining({
        connectorId: 'notion',
        toolName: 'notion.notion_search',
        input: expect.objectContaining({ query: expect.any(String) }),
      }),
    ]);
    await expect(
      readMemoryEntry(dataDir, 'project_opendesign_design_memory'),
    ).resolves.toBeNull();
    expect(listExtractions()[0]).toMatchObject({
      kind: 'connector',
      phase: 'success',
      writtenCount: 0,
    });
  });

  it('tries additional connector queries when the first read is empty', async () => {
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      ...createNotionService(executeCalls),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        if (executeCalls.length === 1) {
          return {
            ok: true,
            connectorId: request.connectorId,
            accountLabel: 'Product wiki',
            toolName: request.toolName,
            safety: notionDefinition.tools[0]!.safety,
            outputSummary: 'No results',
            output: { pages: [] },
          };
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: notionDefinition.tools[0]!.safety,
          outputSummary: 'Found project notes.',
          output: {
            pages: [
              {
                title: 'Memory project',
                text: 'OpenDesign should summarize connector findings when no durable memory is obvious.',
              },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    expect(executeCalls.length).toBeGreaterThan(1);
    expect(executeCalls[0]).toEqual(expect.objectContaining({
      input: expect.objectContaining({
        query: '设计思路 设计偏好 UI UX 视觉风格 品牌 logo 设计系统 OpenDesign',
      }),
    }));
    expect(executeCalls[1]).toEqual(expect.objectContaining({
      input: expect.objectContaining({ query: '设计思路' }),
    }));
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        summary: 'Found project notes.',
      }),
    ]);
    expect(result.suggestions).toHaveLength(1);
  });

  it('continues past readable but off-topic results to find Chinese design notes', async () => {
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      ...createNotionService(executeCalls),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        if (executeCalls.length === 1) {
          return {
            ok: true,
            connectorId: request.connectorId,
            accountLabel: 'Product wiki',
            toolName: request.toolName,
            safety: notionDefinition.tools[0]!.safety,
            outputSummary: 'Found 2 readable items from Notion: clipping, sticker.',
            output: {
              pages: [
                { title: 'clipping', text: 'Saved shopping snippets and unrelated web clips.' },
                { title: 'sticker', text: 'Sticker collection notes for personal errands.' },
              ],
            },
          };
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: notionDefinition.tools[0]!.safety,
          outputSummary: 'Found Chinese design notes.',
          output: {
            pages: [
              {
                title: '设计思路',
                text: 'comfyui 用黑色 logo，整体视觉偏深色主题。',
              },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    expect(executeCalls.length).toBeGreaterThan(1);
    expect(executeCalls.map((call) => (call.input as { query?: string }).query)).toContain('设计思路');
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        summary: 'Found Chinese design notes.',
      }),
    ]);
    expect(result.attemptedLLM).toBe(true);
    expect(result.suggestions).toHaveLength(1);
  });

  it('uses the Notion empty-query fallback when specific title searches miss', async () => {
    const searchPagesTool = defineConnectorTool({
      name: 'notion.notion_search_notion_page',
      providerToolId: 'NOTION_SEARCH_NOTION_PAGE',
      title: 'Search Notion pages and databases',
      description: 'Searches Notion pages and databases by title. If a specific title search misses, try an empty query to list all accessible items and filter client-side.',
      inputSchemaJson: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            default: '',
            description: 'Text to search for in page titles. Try an empty query as a fallback.',
          },
          page_size: { type: 'integer' },
          timestamp: { type: 'string' },
          direction: { type: 'string' },
          filter_value: { type: 'string' },
          filter_property: { type: 'string' },
        },
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
      curation: {
        useCases: ['personal_daily_digest'],
        reason: 'Searches the workspace for personal context.',
      },
    });
    const definition: ConnectorCatalogDefinition = {
      ...notionDefinition,
      tools: [searchPagesTool],
      allowedToolNames: [searchPagesTool.name],
      curatedToolNames: [searchPagesTool.name],
    };
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      listFastDefinitions: () => [definition],
      listConnectorStatuses: () => ({
        notion: { status: 'connected', accountLabel: 'Product wiki' },
      }),
      getStatus: () => ({ status: 'connected', accountLabel: 'Product wiki' }),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        const query = (request.input as { query?: string }).query ?? '';
        if (query !== '') {
          return {
            ok: true,
            connectorId: request.connectorId,
            accountLabel: 'Product wiki',
            toolName: request.toolName,
            safety: searchPagesTool.safety,
            outputSummary: 'Found 2 readable items from Notion: clipping, sticker.',
            output: {
              pages: [
                { title: 'clipping', text: 'Saved shopping snippets and unrelated web clips.' },
                { title: 'sticker', text: 'Sticker collection notes for personal errands.' },
              ],
            },
          };
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: searchPagesTool.safety,
          outputSummary: 'Listed accessible Notion pages.',
          output: {
            pages: [
              { title: 'clipping', text: 'Saved shopping snippets.' },
              { title: '设计思路', text: 'comfyui 用黑色 logo，整体视觉偏深色主题。' },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    const emptyFallbackCall = executeCalls.find((call) => (call.input as { query?: string }).query === '');
    expect(emptyFallbackCall).toEqual(expect.objectContaining({
      input: expect.objectContaining({
        query: '',
        page_size: 25,
        timestamp: 'last_edited_time',
        direction: 'descending',
        filter_value: 'page',
        filter_property: 'object',
      }),
    }));
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        summary: 'Listed accessible Notion pages.',
      }),
    ]);
    expect(result.suggestions).toHaveLength(1);
  });

  it('opens relevant Notion pages after search so page body reaches the memory model', async () => {
    const pageId = '21a58690-0954-80a9-8ab6-ea4c93f87da2';
    const searchPagesTool = defineConnectorTool({
      name: 'notion.notion_search_notion_page',
      providerToolId: 'NOTION_SEARCH_NOTION_PAGE',
      title: 'Search Notion pages and databases',
      description: 'Searches Notion pages and databases by title.',
      inputSchemaJson: {
        type: 'object',
        properties: {
          query: { type: 'string', default: '' },
          page_size: { type: 'integer' },
          timestamp: { type: 'string' },
          direction: { type: 'string' },
          filter_value: { type: 'string' },
          filter_property: { type: 'string' },
        },
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
      curation: {
        useCases: ['personal_daily_digest'],
        reason: 'Searches the workspace for memory context.',
      },
    });
    const getPageMarkdownTool = defineConnectorTool({
      name: 'notion.notion_get_page_markdown',
      providerToolId: 'NOTION_GET_PAGE_MARKDOWN',
      title: 'Get page markdown',
      description: 'Retrieve a Notion page full content rendered as markdown.',
      inputSchemaJson: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          include_transcript: { type: 'boolean' },
        },
        required: ['page_id'],
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
    });
    const definition: ConnectorCatalogDefinition = {
      ...notionDefinition,
      tools: [searchPagesTool, getPageMarkdownTool],
      allowedToolNames: [searchPagesTool.name, getPageMarkdownTool.name],
      curatedToolNames: [searchPagesTool.name],
    };
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      listFastDefinitions: () => [definition],
      listConnectorStatuses: () => ({
        notion: { status: 'connected', accountLabel: 'Product wiki' },
      }),
      getStatus: () => ({ status: 'connected', accountLabel: 'Product wiki' }),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        if (request.toolName === getPageMarkdownTool.name) {
          return {
            ok: true,
            connectorId: request.connectorId,
            accountLabel: 'Product wiki',
            toolName: request.toolName,
            safety: getPageMarkdownTool.safety,
            outputSummary: 'Fetched page markdown.',
            output: {
              markdown: '设计思路\n\ncomfyui 用黑色 logo，整体视觉偏深色主题，信息密度可以更高。',
            },
          };
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: searchPagesTool.safety,
          outputSummary: 'Found 25 readable items from Notion: clipping.',
          output: {
            results: [
              {
                object: 'page',
                id: pageId,
                url: `https://www.notion.so/${pageId.replaceAll('-', '')}`,
                properties: {
                  Name: {
                    title: [{ plain_text: '设计思路' }],
                  },
                },
              },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const localCliRunner = memoryCliRunner();
    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner,
    });

    expect(executeCalls).toEqual([
      expect.objectContaining({ toolName: searchPagesTool.name }),
      expect.objectContaining({
        toolName: getPageMarkdownTool.name,
        input: expect.objectContaining({
          page_id: pageId,
          include_transcript: false,
        }),
      }),
    ]);
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        summary: expect.stringContaining('Read page content: 设计思路'),
      }),
    ]);
    const [runnerCall] = localCliRunner.mock.calls;
    expect(String(runnerCall?.[0]?.user)).toContain('comfyui 用黑色 logo');
    expect(result.suggestions).toHaveLength(1);
  });

  it('tries another search tool when the first tool only finds off-topic pages', async () => {
    const titleSearchTool = defineConnectorTool({
      name: 'notion.notion_search_notion_page',
      providerToolId: 'NOTION_SEARCH_NOTION_PAGE',
      title: 'Search Notion pages and databases',
      description: 'Searches Notion pages and databases by title. If a specific title search misses, try an empty query to list all accessible items.',
      inputSchemaJson: {
        type: 'object',
        properties: {
          query: { type: 'string', default: '' },
          page_size: { type: 'integer' },
        },
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
      curation: { useCases: ['personal_daily_digest'] },
    });
    const broadSearchTool = defineConnectorTool({
      name: 'notion.notion_search',
      providerToolId: 'NOTION_SEARCH',
      title: 'Search Notion',
      description: 'Search Notion pages and databases.',
      inputSchemaJson: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
      curation: { useCases: ['personal_daily_digest'] },
    });
    const definition: ConnectorCatalogDefinition = {
      ...notionDefinition,
      tools: [titleSearchTool, broadSearchTool],
      allowedToolNames: [titleSearchTool.name, broadSearchTool.name],
      curatedToolNames: [titleSearchTool.name, broadSearchTool.name],
    };
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      listFastDefinitions: () => [definition],
      listConnectorStatuses: () => ({
        notion: { status: 'connected', accountLabel: 'Product wiki' },
      }),
      getStatus: () => ({ status: 'connected', accountLabel: 'Product wiki' }),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        if (request.toolName === titleSearchTool.name) {
          return {
            ok: true,
            connectorId: request.connectorId,
            accountLabel: 'Product wiki',
            toolName: request.toolName,
            safety: titleSearchTool.safety,
            outputSummary: 'Found 5 readable items from Notion: clipping.',
            output: { pages: [{ title: 'clipping', text: 'Saved shopping snippets.' }] },
          };
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: broadSearchTool.safety,
          outputSummary: 'Found design thinking note.',
          output: {
            pages: [
              {
                title: '设计思路',
                text: 'comfyui 用黑色 logo，整体视觉偏深色主题。',
              },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    expect(executeCalls.some((call) => call.toolName === broadSearchTool.name)).toBe(true);
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        toolName: broadSearchTool.name,
        summary: 'Found design thinking note.',
      }),
    ]);
    expect(result.suggestions).toHaveLength(1);
  });

  it('tries the next connector tool when a provider tool id is missing', async () => {
    const fallbackTool = defineConnectorTool({
      name: 'notion.notion_search_notion_page',
      providerToolId: 'NOTION_SEARCH_NOTION_PAGE',
      title: 'Search Notion pages and databases',
      description: 'Search Notion pages and databases.',
      inputSchemaJson: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchemaJson: { type: 'object', additionalProperties: true },
      requiredScopes: ['read'],
    });
    const definition: ConnectorCatalogDefinition = {
      ...notionDefinition,
      tools: [...notionDefinition.tools, fallbackTool],
      allowedToolNames: ['notion.notion_search', 'notion.notion_search_notion_page'],
    };
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = {
      listFastDefinitions: () => [definition],
      listConnectorStatuses: () => ({
        notion: { status: 'connected', accountLabel: 'Product wiki' },
      }),
      getStatus: () => ({ status: 'connected', accountLabel: 'Product wiki' }),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => {
        executeCalls.push(request);
        if (request.toolName === 'notion.notion_search') {
          throw new Error('Tool NOTION_SEARCH not found');
        }
        return {
          ok: true,
          connectorId: request.connectorId,
          accountLabel: 'Product wiki',
          toolName: request.toolName,
          safety: fallbackTool.safety,
          outputSummary: 'Found Notion pages from the current search API.',
          output: {
            pages: [
              {
                title: 'Memory source notes',
                text: 'OpenDesign should read the currently available Notion search tool.',
              },
            ],
          },
        };
      },
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      service,
    });

    expect(executeCalls.map((call) => call.toolName)).toEqual([
      'notion.notion_search',
      'notion.notion_search_notion_page',
    ]);
    expect(result.attemptedLLM).toBe(true);
    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        toolName: 'notion.notion_search_notion_page',
        summary: 'Found Notion pages from the current search API.',
      }),
    ]);
  });

  it('does not invent suggestions when the model finds no design memory', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ entries: [] }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const service = createNotionService();

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      service,
    });

    expect(result.attemptedLLM).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('keeps derived read summaries out of suggested memories', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ entries: [] }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const service = {
      ...createNotionService(),
      execute: async (request: { connectorId: string; toolName: string; input: unknown }) => ({
        ok: true,
        connectorId: request.connectorId,
        accountLabel: 'Product wiki',
        toolName: request.toolName,
        safety: notionDefinition.tools[0]!.safety,
        outputSummary: 'notion.notion_search',
        output: {
          pages: [
            {
              title: 'Memory source notes',
              text: 'OpenDesign should summarize connector findings before saving them as memory.',
            },
          ],
        },
      }),
    } as unknown as ConnectorService;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      service,
    });

    expect(result.connectors).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        summary: 'Found 1 readable item from Notion: Memory source notes.',
      }),
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it('filters connector meta copy even when the model returns it', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entries: [
                {
                  type: 'reference',
                  name: 'GitHub context summary',
                  description: 'Summary from GitHub',
                  body: 'OpenDesign read GitHub via List notifications. Summary: Found 5 readable items from GitHub. Save this if it should be reused as context in future chats.',
                },
                {
                  type: 'feedback',
                  name: 'UI density preference',
                  description: 'The user prefers denser design interfaces',
                  body: 'The user prefers OpenDesign UI to use higher information density with clear hierarchy instead of spacious marketing-style cards.',
                },
              ],
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service: createNotionService(),
      localCliRunner: memoryCliRunner(JSON.stringify({
        entries: [
          {
            type: 'reference',
            name: 'GitHub context summary',
            description: 'Summary from GitHub',
            body: 'OpenDesign read GitHub via List notifications. Summary: Found 5 readable items from GitHub. Save this if it should be reused as context in future chats.',
          },
          {
            type: 'feedback',
            name: 'UI density preference',
            description: 'The user prefers denser design interfaces',
            body: 'The user prefers OpenDesign UI to use higher information density with clear hierarchy instead of spacious marketing-style cards.',
          },
        ],
      })),
    });

    expect(result.suggestions).toEqual([
      expect.objectContaining({
        type: 'feedback',
        name: 'UI density preference',
        body: expect.stringContaining('higher information density'),
      }),
    ]);
  });

  it('uses the current Local CLI for same-as-chat connector suggestions', async () => {
    await writeMemoryConfig(dataDir, { extraction: null });
    const localCliRunner = vi.fn(async () => JSON.stringify({
      entries: [
        {
          type: 'feedback',
          name: 'Design memory source',
          description: 'Connector memory should use Claude Code',
          body: 'OpenDesign connector memory extraction should use the same Claude Code Local CLI selected for chat when the memory model is set to same as chat.',
        },
      ],
    }));

    const result = await suggestMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      chatModel: 'default',
      service: createNotionService(),
      localCliRunner,
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(localCliRunner).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      model: 'default',
      projectRoot: process.cwd(),
      dataDir,
    }));
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        type: 'feedback',
        name: 'Design memory source',
      }),
    ]);
    expect(listExtractions()[0]).toMatchObject({
      kind: 'connector',
      phase: 'success',
      provider: {
        kind: 'anthropic',
        model: 'default',
        credentialSource: 'chat-cli',
      },
    });
  });

  it('reads connected app context and saves connector-sourced memory', async () => {
    const executeCalls: Array<{ connectorId: string; toolName: string; input: unknown }> = [];
    const service = createNotionService(executeCalls);

    const result = await extractMemoryFromConnectors(dataDir, {
      projectsRoot: process.cwd(),
      projectRoot: process.cwd(),
      connectorIds: ['notion'],
      chatAgentId: 'claude',
      service,
      localCliRunner: memoryCliRunner(),
    });

    expect(result.attemptedLLM).toBe(true);
    expect(result.connectors).toEqual([
      expect.objectContaining({
        connectorId: 'notion',
        connectorName: 'Notion',
        accountLabel: 'Product wiki',
        status: 'succeeded',
        toolName: 'notion.notion_search',
      }),
    ]);
    expect(executeCalls).toEqual([
      expect.objectContaining({
        connectorId: 'notion',
        toolName: 'notion.notion_search',
        input: expect.objectContaining({ query: expect.any(String) }),
      }),
    ]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      id: 'project_opendesign_design_memory',
      type: 'project',
      name: 'OpenDesign design memory',
    });

    const stored = await readMemoryEntry(dataDir, 'project_opendesign_design_memory');
    expect(stored?.body).toContain('design preferences');
    expect(listExtractions()[0]).toMatchObject({
      kind: 'connector',
      phase: 'success',
      writtenCount: 1,
    });
  });
});
