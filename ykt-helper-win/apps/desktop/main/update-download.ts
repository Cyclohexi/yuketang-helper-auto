import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PortableManifest } from './update-release.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const IDLE_TIMEOUT_MS = 45_000;

export class UpdateTransferError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly discardPartial = false,
  ) {
    super(message);
  }
}

export function retryableUpdateError(error: unknown): boolean {
  if (error instanceof UpdateTransferError) return error.retryable;
  if (error && typeof error === 'object' && 'code' in error) {
    // Local disk errors cannot be fixed by reconnecting to GitHub.
    if (/^(?:EACCES|EPERM|ENOSPC|EIO|EROFS|ENOENT)$/.test(String(error.code)))
      return false;
  }
  return true; // Fetch/stream failures include Chromium ERR_HTTP2_PROTOCOL_ERROR.
}

export function updateHttpError(status: number): UpdateTransferError {
  return new UpdateTransferError(
    `更新源访问失败（HTTP ${status}）。`,
    status === 408 || status === 429 || status >= 500,
  );
}

interface DownloadOptions {
  url: string;
  manifest: PortableManifest;
  directory: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  onRetry: (progress: number, attempt: number, milliseconds: number) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export async function waitForUpdateRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

/** Range requests use the original release URL each time, refreshing redirects.
 * The cache key is the validated SHA-256, so another release never appends here.
 * Only the complete, verified archive is returned for installation. */
export async function downloadUpdateArchive(
  options: DownloadOptions,
): Promise<string> {
  const { manifest, signal } = options;
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new UpdateTransferError('更新缓存标识无效。');
  signal.throwIfAborted();
  await mkdir(options.directory, { recursive: true });
  const path = join(options.directory, `download-${manifest.sha256}.part`);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new UpdateTransferError('更新缓存不是普通文件。');
  const file = await open(path, existing ? 'r+' : 'wx+');
  let size = (await file.stat()).size;
  let failures = 0;
  let discard = false;
  const progress = () => Math.floor((size * 100) / manifest.size);
  try {
    if (size > manifest.size) {
      await file.truncate(0);
      size = 0;
    }
    options.onProgress(progress());
    while (size < manifest.size) {
      signal.throwIfAborted();
      const requestAbort = new AbortController();
      const requestSignal = AbortSignal.any([signal, requestAbort.signal]);
      let idleTimer: ReturnType<typeof setTimeout>;
      const refreshTimeout = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            requestAbort.abort(
              new DOMException('更新连接长时间无响应。', 'TimeoutError'),
            ),
          IDLE_TIMEOUT_MS,
        );
        idleTimer.unref();
      };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      refreshTimeout();
      try {
        const start = size;
        const end = Math.min(start + CHUNK_BYTES, manifest.size) - 1;
        const response = await options.fetch(options.url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: requestSignal,
          cache: 'no-store',
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw updateHttpError(response.status);
        }
        if (!response.body)
          throw new UpdateTransferError('更新包响应为空。', true);
        reader = response.body.getReader();
        let expected: number;
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get('content-range') ?? '',
          );
          if (
            !range ||
            Number(range[1]) !== start ||
            Number(range[2]) < start ||
            Number(range[2]) > end ||
            Number(range[3]) !== manifest.size
          )
            throw new UpdateTransferError(
              '更新源返回的续传范围无效，已取消更新。',
              false,
              true,
            );
          expected = Number(range[2]) - start + 1;
        } else if (response.status === 200) {
          // A server ignoring Range sends the whole file. Never append it.
          await file.truncate(0);
          size = 0;
          options.onProgress(0);
          expected = manifest.size;
        } else {
          throw new UpdateTransferError(
            '更新源返回的下载状态无效。',
            false,
            true,
          );
        }
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          requestSignal.throwIfAborted();
          if (done) break;
          refreshTimeout();
          if (
            received + value.byteLength > expected ||
            size + value.byteLength > manifest.size
          )
            throw new UpdateTransferError(
              '更新包超出声明的下载范围。',
              false,
              true,
            );
          // Explicit positions also handle short disk writes. Windows append-only
          // handles cannot truncate when a server ignores Range.
          let written = 0;
          while (written < value.byteLength) {
            const result = await file.write(
              value,
              written,
              value.byteLength - written,
              size + written,
            );
            if (result.bytesWritten === 0)
              throw Object.assign(new Error('更新缓存写入失败。'), {
                code: 'EIO',
              });
            written += result.bytesWritten;
          }
          received += value.byteLength;
          size += value.byteLength;
          options.onProgress(progress());
        }
        if (received !== expected)
          throw new UpdateTransferError('更新下载连接提前中断。', true);
        failures = 0;
      } catch (error) {
        discard = error instanceof UpdateTransferError && error.discardPartial;
        signal.throwIfAborted();
        if (!retryableUpdateError(error)) throw error;
        size = (await file.stat()).size;
        // A stream can fail on its final read after every byte was received.
        if (size === manifest.size) break;
        const milliseconds = RETRY_DELAYS[failures++];
        if (milliseconds === undefined)
          throw new UpdateTransferError(
            '网络连接多次中断，已保留下载进度，点击继续下载。',
          );
        options.onRetry(progress(), failures, milliseconds);
        await (options.wait ?? waitForUpdateRetry)(milliseconds, signal);
      } finally {
        clearTimeout(idleTimer!);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
    signal.throwIfAborted();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal }))
      hash.update(chunk);
    if (
      (await file.stat()).size !== manifest.size ||
      hash.digest('hex') !== manifest.sha256
    ) {
      discard = true;
      throw new UpdateTransferError(
        '更新包完整性校验失败，已清除损坏的下载缓存，请重试。',
        false,
        true,
      );
    }
    return path;
  } finally {
    await file.close();
    if (discard) await rm(path, { force: true });
  }
}
