import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadUpdateArchive,
  waitForUpdateRetry,
} from '../../apps/desktop/main/update-download.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const content = Buffer.from('portable archive bytes');
async function fixture(bytes = content) {
  const directory = await mkdtemp(join(tmpdir(), 'ykt-update-resume-'));
  directories.push(directory);
  const manifest = {
    version: '2.3.0',
    file: 'YuketangHelper-v2.3.0-Windows-x64-Portable.zip',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const rangeResponse = (start: number, end = bytes.length - 1) =>
    new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    });
  const fetch = vi.fn(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(
        new Headers(init?.headers).get('range')!,
      );
      return rangeResponse(Number(match![1]), Number(match![2]));
    },
  );
  const options = {
    directory,
    manifest,
    url: 'https://github.com/portable.zip',
    fetch,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onRetry: vi.fn(),
    wait: vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {}),
  };
  return {
    options,
    rangeResponse,
    path: join(directory, `download-${manifest.sha256}.part`),
  };
}
function interrupted(bytes: Uint8Array, total: number) {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
        } else controller.error(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'));
      },
    }),
    {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${total - 1}/${total}` },
    },
  );
}

describe('resumable portable update download', () => {
  it('continues from saved bytes after an HTTP/2 stream failure', async () => {
    const { options, path } = await fixture();
    options.fetch.mockResolvedValueOnce(
      interrupted(content.subarray(0, 7), content.length),
    );
    await expect(downloadUpdateArchive(options)).resolves.toBe(path);
    expect(await readFile(path)).toEqual(content);
    expect(
      new Headers(options.fetch.mock.calls[1]![1]!.headers).get('range'),
    ).toBe(`bytes=7-${content.length - 1}`);
    expect(options.onRetry).toHaveBeenCalledWith(
      Math.floor(700 / content.length),
      1,
      1000,
    );
  });
  it('keeps partial bytes after retries are exhausted and resumes in a new call', async () => {
    const { options, rangeResponse, path } = await fixture();
    options.fetch.mockRejectedValue(new TypeError('fetch failed'));
    options.fetch.mockResolvedValueOnce(
      interrupted(content.subarray(0, 7), content.length),
    );
    await expect(downloadUpdateArchive(options)).rejects.toThrow(
      '已保留下载进度',
    );
    expect(options.fetch).toHaveBeenCalledTimes(6);
    expect(options.wait.mock.calls.map(([ms]) => ms)).toEqual([
      1000, 2000, 4000, 8000, 15000,
    ]);
    expect(await readFile(path)).toEqual(content.subarray(0, 7));
    options.fetch.mockReset().mockResolvedValue(rangeResponse(7));
    await downloadUpdateArchive({ ...options });
    expect(
      new Headers(options.fetch.mock.calls[0]![1]!.headers).get('range'),
    ).toBe(`bytes=7-${content.length - 1}`);
    expect(await readFile(path)).toEqual(content);
  });
  it('bounds each range to 4 MiB rather than opening one long transfer', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 42);
    const { options, path } = await fixture(bytes);
    await downloadUpdateArchive(options);
    expect(
      options.fetch.mock.calls.map(([, init]) =>
        new Headers(init!.headers).get('range'),
      ),
    ).toEqual([
      'bytes=0-4194303',
      'bytes=4194304-8388607',
      'bytes=8388608-9437183',
    ]);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  });
  it('restarts safely if the server ignores a resumed Range request', async () => {
    const { options, path } = await fixture();
    await writeFile(path, content.subarray(0, 7));
    options.fetch.mockResolvedValue(new Response(content));
    await downloadUpdateArchive(options);
    expect(await readFile(path)).toEqual(content);
    expect(options.onProgress).toHaveBeenCalledWith(0);
  });
  it.each(['bytes 0-20/22', 'bytes 8-20/22', 'bytes 7-999/22', 'invalid'])(
    'rejects inconsistent Content-Range %s without using cached data',
    async (header) => {
      const { options, path } = await fixture();
      await writeFile(path, content.subarray(0, 7));
      options.fetch.mockResolvedValue(
        new Response(content.subarray(7), {
          status: 206,
          headers: { 'Content-Range': header },
        }),
      );
      await expect(downloadUpdateArchive(options)).rejects.toThrow(
        '续传范围无效',
      );
      expect(options.fetch).toHaveBeenCalledOnce();
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('retries a clean but prematurely closed response from its last written byte', async () => {
    const { options, path } = await fixture();
    options.fetch.mockResolvedValueOnce(
      new Response(content.subarray(0, 7), {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-${content.length - 1}/${content.length}`,
        },
      }),
    );
    await downloadUpdateArchive(options);
    expect(await readFile(path)).toEqual(content);
    expect(options.onRetry).toHaveBeenCalledOnce();
  });
  it('retries temporary HTTP failures but leaves authorization failures for manual retry', async () => {
    const { options } = await fixture();
    options.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    await downloadUpdateArchive(options);
    expect(options.onRetry).toHaveBeenCalledOnce();
    const other = await fixture();
    other.options.fetch.mockResolvedValue(new Response('', { status: 403 }));
    await expect(downloadUpdateArchive(other.options)).rejects.toThrow(
      'HTTP 403',
    );
    expect(other.options.fetch).toHaveBeenCalledOnce();
  });
  it('removes a corrupt complete cache instead of installing or trusting it', async () => {
    const { options, path } = await fixture();
    await writeFile(path, Buffer.alloc(content.length));
    await expect(downloadUpdateArchive(options)).rejects.toThrow(
      '完整性校验失败',
    );
    expect(options.fetch).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('validates a complete cached package without downloading it again', async () => {
    const { options, path } = await fixture();
    await writeFile(path, content);
    await downloadUpdateArchive(options);
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it('stops immediately when disposed during backoff and keeps the received prefix', async () => {
    const { options, path } = await fixture();
    const abort = new AbortController();
    options.fetch.mockResolvedValueOnce(
      interrupted(content.subarray(0, 7), content.length),
    );
    await expect(
      downloadUpdateArchive({
        ...options,
        signal: abort.signal,
        onRetry: () => abort.abort(),
        wait: waitForUpdateRetry,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.fetch).toHaveBeenCalledOnce();
    expect(await readFile(path)).toEqual(content.subarray(0, 7));
  });
  it('does not retry local disk failures', async () => {
    const { options } = await fixture();
    options.fetch.mockRejectedValue(
      Object.assign(new Error('No space'), { code: 'ENOSPC' }),
    );
    await expect(downloadUpdateArchive(options)).rejects.toThrow('No space');
    expect(options.fetch).toHaveBeenCalledOnce();
  });
  it('reconnects a stalled request and stops when cancellation follows', async () => {
    const { options } = await fixture();
    const abort = new AbortController();
    options.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    );
    vi.useFakeTimers();
    const pending = expect(
      downloadUpdateArchive({
        ...options,
        signal: abort.signal,
        onRetry: () => abort.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(options.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(options.fetch).toHaveBeenCalledOnce();
  });
  it('rejects oversized response bytes without leaving a reusable corrupt cache', async () => {
    const { options, path } = await fixture();
    options.fetch.mockResolvedValue(
      new Response(Buffer.alloc(content.length + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-${content.length - 1}/${content.length}`,
        },
      }),
    );
    await expect(downloadUpdateArchive(options)).rejects.toThrow('超出声明');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(options.fetch).toHaveBeenCalledOnce();
  });
});
