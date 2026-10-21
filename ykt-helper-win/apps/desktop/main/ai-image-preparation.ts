import { withAiRequestRetry } from '@ykt/backend';

export async function prepareAiImageWithRetry(
  value: string,
  options: {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    retryEnabled: () => Promise<boolean>;
  },
): Promise<string> {
  if (value.startsWith('data:image/')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('课件图片必须使用 HTTPS。');
  }
  if (url.protocol !== 'https:') throw new Error('课件图片必须使用 HTTPS。');
  return withAiRequestRetry(
    async () => {
      let response: Response;
      try {
        response = await options.fetch(value, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new Error('课件图片读取超时，请重新请求。', { cause: error });
        throw error;
      }
      if (!response.ok)
        throw new Error(`课件图片读取失败：HTTP ${response.status}`);
      const contentType = (response.headers.get('content-type') ?? 'image/jpeg')
        .split(';')[0]!
        .trim();
      if (!contentType.startsWith('image/'))
        throw new Error('课件资源不是图片。');
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > 16 * 1024 * 1024)
        throw new Error('课件图片超过 16MB。');
      return `data:${contentType};base64,${body.toString('base64')}`;
    },
    { enabled: options.retryEnabled },
  );
}
