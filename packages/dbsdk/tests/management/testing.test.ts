/**
 * Fixture testing adapter tests: unscripted behavior fails loudly, calls are recorded,
 * and the shipped client wraps the fixture adapter.
 */

import { describe, expect, it, vi } from 'vitest';

import { createManagementFixture } from '../../src/management/testing.js';

describe('management fixture', () => {
  it('fails loudly on unscripted mutations and gets', async () => {
    const { client } = createManagementFixture();
    await expect(client.get({ kind: 'project', id: 'p' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(client.create({ kind: 'project', name: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(client.delete({ kind: 'project', id: 'p' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('returns an honest empty page when list is unscripted', async () => {
    const { client } = createManagementFixture();
    const page = await client.list('project', { limit: 5 });
    expect(page).toEqual({ kind: 'project', resources: [], cursor: null });
  });

  it('records every call on raw.calls and onCall', async () => {
    const onCall = vi.fn();
    const { adapter, client } = createManagementFixture({
      handlers: {
        get: async () => ({
          kind: 'project',
          providerId: 'test',
          id: 'p-1',
          name: 'app',
          region: null,
          status: 'active',
          providerStatus: null,
          createdAt: null,
          updatedAt: null,
          raw: {},
        }),
      },
      onCall,
    });
    await client.get({ kind: 'project', id: 'p-1' });
    await client.list('project');
    expect(adapter.raw.calls.map((call) => call.verb)).toEqual(['get', 'list']);
    expect(onCall).toHaveBeenCalledTimes(2);
  });

  it('supports a custom open provider id and capability overrides', () => {
    const { adapter, client } = createManagementFixture({
      id: 'convex',
      capabilities: {
        resourceKinds: ['deployment'],
        supported: { update: [], delete: ['deployment'] },
        pagination: false,
        asyncOperations: false,
      },
    });
    expect(adapter.id).toBe('convex');
    expect(client.providerId).toBe('convex');
    expect(client.capabilities.resourceKinds).toEqual(['deployment']);
    expect(client.capabilities.supported.update).toEqual([]);
  });

  it('exposes getOperation handlers for wait-style scripts', async () => {
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => ({
          id: 'op-1',
          providerId: 'test',
          action: 'other',
          ref: null,
          status: 'running',
          providerStatus: null,
          createdAt: null,
          finishedAt: null,
          error: null,
          raw: {},
        }),
      },
    });
    await expect(
      client.wait(
        {
          id: 'op-1',
          providerId: 'test',
          action: 'other',
          ref: null,
          status: 'running',
          providerStatus: null,
          createdAt: null,
          finishedAt: null,
          error: null,
          raw: {},
        },
        { timeoutMs: 40, pollIntervalMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
