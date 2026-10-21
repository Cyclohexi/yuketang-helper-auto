/** Bounded retries for transport failures; callers keep the same LLM turn. */
export async function withAiRequestRetry<T>(
  request: () => Promise<T>,
  options: { enabled: () => Promise<boolean>; signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      if (
        attempt >= 2 ||
        options.signal?.aborted ||
        !isTransientAiError(error) ||
        !(await options.enabled())
      )
        throw error;
      await wait(1000 * 2 ** attempt, options.signal);
      options.signal?.throwIfAborted();
      if (!(await options.enabled())) throw error;
    }
  }
}

export function isTransientAiError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const item = current as {
      name?: string;
      message?: string;
      code?: string;
      cause?: unknown;
    };
    if (item.name === 'AbortError') return false;
    const text = `${item.name ?? ''} ${item.code ?? ''} ${item.message ?? ''}`;
    const http = /\bHTTP\s+(\d{3})\b/i.exec(text);
    if (http)
      return (
        [408, 429].includes(Number(http[1])) ||
        (Number(http[1]) >= 500 && Number(http[1]) <= 599)
      );
    if (
      /fetch failed|failed to fetch|network\s*(?:error|request failed)|TimeoutError|timed?\s*out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)|net::ERR_(?:FAILED|TIMED_OUT|CONNECTION_(?:RESET|REFUSED|CLOSED|ABORTED)|NAME_NOT_RESOLVED|NETWORK_CHANGED|INTERNET_DISCONNECTED)/i.test(
        text,
      )
    )
      return true;
    current = item.cause;
  }
  return false;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('AI request cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
