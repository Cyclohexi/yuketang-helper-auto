import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { NetworkEntry } from '@ykt/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistentNetworkArchive } from '../../apps/desktop/main/persistent-network-archive.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('persistent network archive', () => {
  it('keeps sanitized captures across restarts', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'network-capture.sqlite');
    const first = new PersistentNetworkArchive(path, { flushDelayMs: 60_000 });
    first.append(httpEntry('first'));
    first.close();

    const second = new PersistentNetworkArchive(path);
    const entries = second.listRecent();
    const serialized = JSON.stringify(entries);
    expect(entries).toHaveLength(1);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('body-secret');
    expect(serialized).not.toContain('url-secret');
    expect(second.stats().entries).toBe(1);
    second.close();
  });

  it('keeps only the newest entries when the configured limit is reached', async () => {
    const directory = await temporaryDirectory();
    const archive = new PersistentNetworkArchive(
      join(directory, 'network-capture.sqlite'),
      { maxEntries: 2, flushDelayMs: 60_000 },
    );
    archive.append(httpEntry('one'));
    archive.append(httpEntry('two'));
    archive.append(httpEntry('three'));
    archive.flush();
    archive.close();

    const reopened = new PersistentNetworkArchive(
      join(directory, 'network-capture.sqlite'),
      { maxEntries: 2 },
    );
    expect(reopened.listRecent().map((entry) => entry.requestId)).toEqual([
      'two',
      'three',
    ]);
    reopened.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ykt-network-archive-'));
  directories.push(directory);
  return directory;
}

function httpEntry(requestId: string): NetworkEntry {
  return {
    id: requestId,
    sequence: 1,
    timestamp: new Date().toISOString(),
    source: 'browser',
    kind: 'http',
    phase: 'body',
    requestId,
    method: 'POST',
    url: 'https://changjiang.yuketang.cn/api/signin?token=url-secret',
    resourceType: 'XHR',
    statusCode: 200,
    durationMs: 12,
    requestHeaders: {
      Authorization: 'Bearer header-secret',
      Cookie: 'session=cookie-secret',
    },
    requestBody: JSON.stringify({ token: 'body-secret', action: 'signin' }),
    responseHeaders: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'body-secret', result: 'ok' }),
    bodyEncoding: 'utf8',
    error: null,
  };
}
