import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAppDataStore, MemorySecretStore } from '@ykt/storage';
import { BackendRuntime } from './runtime.js';
import type { AiProviderPlugin } from './llm/provider.js';

afterEach(() => vi.useRealTimers());

describe('AI proposal retry setting', () => {
  it.each([true, false])(
    'honors automatic retry=%s without duplicating chat messages',
    async (enabled) => {
      vi.useFakeTimers();
      const dataStore = new MemoryAppDataStore();
      const secretStore = new MemorySecretStore();
      await dataStore.updateSettings({
        aiAutoRetryEnabled: enabled,
        activeAiProfileId: 'test-profile',
        aiProfiles: [
          {
            id: 'test-profile',
            name: 'Test',
            providerId: 'fixture',
            baseUrl: 'https://example.test/v1',
            model: 'text-model',
            visionModel: '',
            ocrModel: '',
            translationModel: '',
            temperature: null,
            models: [],
            discoveredAt: '',
          },
        ],
      });
      await secretStore.set('ai-profile:test-profile:main', 'fixture-only');
      const complete = vi
        .fn<AiProviderPlugin['complete']>()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue('Recovered answer');
      const runtime = new BackendRuntime({
        dataStore,
        secretStore,
        aiProviders: [
          { id: 'fixture', discoverModels: async () => [], complete },
        ],
      });
      await runtime.start();
      try {
        const request = runtime.facade.generateAnswerProposal({
          contextId: 'fixture-question',
          sessionId: 'fixture-session',
          customPrompt: 'Explain this question',
        });
        await vi.runAllTimersAsync();
        const proposal = await request;
        expect(proposal.status).toBe(enabled ? 'ready' : 'failed');
        expect(complete).toHaveBeenCalledTimes(enabled ? 2 : 1);
        if (enabled) {
          expect(complete.mock.calls[1]![0].messages).toEqual(
            complete.mock.calls[0]![0].messages,
          );
          expect(complete.mock.calls[1]![0].signal).toBe(
            complete.mock.calls[0]![0].signal,
          );
        }
        expect(proposal.sessionId).toBe('fixture-session');
      } finally {
        await runtime.stop();
      }
    },
  );
});
