import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAiImageWithRetry } from '../../apps/desktop/main/ai-image-preparation.js';

afterEach(() => vi.useRealTimers());

describe('AI image preparation retry', () => {
  it.each(['http://example.test/slide.png', 'not-a-url'])(
    'rejects an invalid image URL without retrying: %s',
    async (url) => {
      const fetch = vi.fn();
      await expect(
        prepareAiImageWithRetry(url, { fetch, retryEnabled: async () => true }),
      ).rejects.toThrow('HTTPS');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    'honors retry=%s before the model request is created',
    async (enabled) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
        .mockResolvedValue(
          new Response('fixture-image', {
            headers: { 'content-type': 'image/png' },
          }),
        );
      const result = prepareAiImageWithRetry('https://example.test/slide.png', {
        fetch,
        retryEnabled: async () => enabled,
      });
      const checked = enabled
        ? expect(result).resolves.toMatch(/^data:image\/png;base64,/)
        : expect(result).rejects.toThrow('ERR_CONNECTION_RESET');
      await vi.runAllTimersAsync();
      await checked;
      expect(fetch).toHaveBeenCalledTimes(enabled ? 2 : 1);
    },
  );

  it('preserves the timeout cause and caps retries', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const result = prepareAiImageWithRetry('https://example.test/slide.png', {
      fetch,
      retryEnabled: async () => true,
    });
    const checked = expect(result).rejects.toThrow('课件图片读取超时');
    await vi.runAllTimersAsync();
    await checked;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a forbidden image or a non-image resource', async () => {
    for (const response of [
      new Response('', { status: 403 }),
      new Response('html', { headers: { 'content-type': 'text/html' } }),
    ]) {
      const fetch = vi.fn().mockResolvedValue(response);
      await expect(
        prepareAiImageWithRetry('https://example.test/slide.png', {
          fetch,
          retryEnabled: async () => true,
        }),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('passes local image data through without a network call', async () => {
    const fetch = vi.fn();
    expect(
      await prepareAiImageWithRetry('data:image/png;base64,Zml4dHVyZQ==', {
        fetch,
        retryEnabled: async () => true,
      }),
    ).toBe('data:image/png;base64,Zml4dHVyZQ==');
    expect(fetch).not.toHaveBeenCalled();
  });
});
