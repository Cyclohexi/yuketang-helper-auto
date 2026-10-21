import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientAiError, withAiRequestRetry } from './request-retry.js';

afterEach(() => vi.useRealTimers());

describe('AI transient request retry', () => {
  it('backs off for 1 and 2 seconds, then returns a recovered response', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new Error('AI 接口请求失败：HTTP 503'))
      .mockResolvedValue('answer');
    const result = withAiRequestRetry(request, { enabled: async () => true });
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('answer');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('caps repeated failures at three total attempts', async () => {
    vi.useFakeTimers();
    const error = new TypeError('fetch failed');
    const request = vi.fn().mockRejectedValue(error);
    const result = withAiRequestRetry(request, { enabled: async () => true });
    const failed = expect(result).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await failed;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    new Error('AI 接口请求失败：HTTP 401'),
    new Error('AI 接口请求失败：HTTP 400'),
    new SyntaxError('invalid JSON'),
    new Error('答案格式不受支持'),
  ])(
    'does not retry configuration or response-format failures: %s',
    async (error) => {
      const request = vi.fn().mockRejectedValue(error);
      await expect(
        withAiRequestRetry(request, { enabled: async () => true }),
      ).rejects.toBe(error);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('stops when retry is disabled during backoff', async () => {
    vi.useFakeTimers();
    let enabled = true;
    const request = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = withAiRequestRetry(request, {
      enabled: async () => enabled,
    });
    const failed = expect(result).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(0);
    enabled = false;
    await vi.runAllTimersAsync();
    await failed;
    expect(request).toHaveBeenCalledOnce();
  });

  it('cancels the backoff when a new turn aborts the old request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = withAiRequestRetry(request, {
      enabled: async () => true,
      signal: controller.signal,
    });
    const failed = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failed;
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledOnce();
  });

  it('recognizes timeout and nested socket errors without retrying explicit cancellation', () => {
    expect(
      isTransientAiError(new DOMException('timeout', 'TimeoutError')),
    ).toBe(true);
    expect(
      isTransientAiError(
        new Error('request failed', {
          cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    expect(isTransientAiError(new DOMException('aborted', 'AbortError'))).toBe(
      false,
    );
  });
});
