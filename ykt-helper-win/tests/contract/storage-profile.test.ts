import { cpSync, existsSync } from 'node:fs';
import type * as FileSystem from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  legacyStorageDirectories,
  prepareStorageDirectory,
  storageProfileDirectory,
} from '../../apps/desktop/main/storage-profile.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, cpSync: vi.fn(original.cpSync) };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ykt-配置-'));
  directories.push(root);
  return { root, target: join(root, 'Local', 'YuketangHelper') };
}
async function profile(root: string, name: string, configured = true) {
  const directory = join(root, name);
  const file = join(directory, 'storage', 'yuketang.sqlite');
  await mkdir(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(
    'CREATE TABLE settings(key TEXT, value TEXT); CREATE TABLE users(id TEXT);',
  );
  database.prepare('INSERT INTO settings VALUES (?, ?)').run('browser', '{}');
  if (configured)
    database
      .prepare('INSERT INTO settings VALUES (?, ?)')
      .run('autoAnswer', 'true');
  database.close();
  await writeFile(
    join(directory, 'storage', 'credentials.json'),
    'encrypted-fixture',
  );
  await mkdir(join(directory, 'Partitions', 'yuketang-browser'), {
    recursive: true,
  });
  await writeFile(
    join(directory, 'Partitions', 'yuketang-browser', 'Cookies'),
    'session-fixture',
  );
  return { directory, file };
}

describe('fixed desktop storage profile', () => {
  it('uses one Windows directory for source, portable, and renamed executables', () => {
    const base = {
      appData: join('C:', 'Users', 'test', 'AppData', 'Roaming'),
      localAppData: join('C:', 'Users', 'test', 'AppData', 'Local'),
      platform: 'win32' as const,
    };
    const expected = join(base.localAppData, 'YuketangHelper');
    for (const executable of [
      'electron.exe',
      'YuketangHelper.exe',
      '雨课堂助手.exe',
    ]) {
      for (const argv of [[], ['--portable']]) {
        expect(storageProfileDirectory({ ...base, executable, argv })).toBe(
          expected,
        );
      }
    }
  });
  it('isolates debug data without importing real credentials', async () => {
    const { root, target } = await fixture();
    const old = await profile(root, 'old');
    const debug = storageProfileDirectory({
      appData: root,
      localAppData: dirname(target),
      platform: 'win32',
      executable: 'electron.exe',
      argv: ['--portable', '--debug-profile'],
    });
    expect(debug).toBe(`${target}-debug`);
    expect(prepareStorageDirectory(debug, [old.directory], true)).toBeNull();
    expect(existsSync(join(debug, 'storage', 'credentials.json'))).toBe(false);
  });
  it('copies configured data and sessions once and retains the original', async () => {
    const { root, target } = await fixture();
    const old = await profile(root, '旧数据');
    expect(prepareStorageDirectory(target, [old.directory])).toBe(
      old.directory,
    );
    expect(
      await readFile(join(target, 'storage', 'credentials.json'), 'utf8'),
    ).toBe('encrypted-fixture');
    expect(
      await readFile(
        join(target, 'Partitions', 'yuketang-browser', 'Cookies'),
        'utf8',
      ),
    ).toBe('session-fixture');
    expect(existsSync(old.file)).toBe(true);
    await writeFile(join(target, 'storage', 'credentials.json'), 'new-config');
    expect(prepareStorageDirectory(target, [old.directory])).toBeNull();
    expect(
      await readFile(join(target, 'storage', 'credentials.json'), 'utf8'),
    ).toBe('new-config');
  });
  it('prefers real settings over a newer just-opened profile', async () => {
    const { root, target } = await fixture();
    const configured = await profile(root, 'configured');
    const empty = await profile(root, 'empty', false);
    await utimes(
      configured.file,
      new Date('2020-01-01'),
      new Date('2020-01-01'),
    );
    expect(
      prepareStorageDirectory(target, [empty.directory, configured.directory]),
    ).toBe(configured.directory);
  });
  it('selects the newest of two configured profiles without merging them', async () => {
    const { root, target } = await fixture();
    const older = await profile(root, 'older');
    const newer = await profile(root, 'newer');
    await utimes(older.file, new Date('2020-01-01'), new Date('2020-01-01'));
    expect(
      prepareStorageDirectory(target, [older.directory, newer.directory]),
    ).toBe(newer.directory);
  });
  it('does not create a blank target when legacy data cannot be read', async () => {
    const { root, target } = await fixture();
    const old = await profile(root, 'broken');
    await writeFile(old.file, 'not a SQLite database');
    expect(() => prepareStorageDirectory(target, [old.directory])).toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it('finds the legacy portable and source directories', () => {
    const options = {
      appData: 'roaming',
      executable: join('app', 'YuketangHelper.exe'),
      argv: [],
      platform: 'win32' as const,
    };
    const candidates = legacyStorageDirectories(options);
    expect(
      candidates.some((candidate) =>
        candidate.endsWith(join('app', 'ykt-helper-data')),
      ),
    ).toBe(true);
    expect(
      candidates.some((candidate) =>
        candidate.endsWith(join('@ykt', 'desktop')),
      ),
    ).toBe(true);
  });
  it('retains a pending marker after a copy failure and blocks the next launch', async () => {
    const { root, target } = await fixture();
    const old = await profile(root, 'locked');
    vi.mocked(cpSync).mockImplementationOnce(() => {
      throw new Error('File is locked');
    });
    expect(() => prepareStorageDirectory(target, [old.directory])).toThrow(
      '迁移未完成',
    );
    expect(existsSync(old.file)).toBe(true);
    expect(existsSync(`${target}.migration-pending.json`)).toBe(true);
    expect(() => prepareStorageDirectory(target, [old.directory])).toThrow(
      '上次数据迁移',
    );
  });
  it('does not activate a partial directory from an interrupted migration', async () => {
    const { root, target } = await fixture();
    const old = await profile(root, 'old');
    await mkdir(target, { recursive: true });
    await writeFile(`${target}.migration-pending.json`, '{}');
    await writeFile(join(target, 'partial.txt'), 'keep for recovery');
    expect(() => prepareStorageDirectory(target, [old.directory])).toThrow(
      '上次数据迁移',
    );
    expect(await readFile(join(target, 'partial.txt'), 'utf8')).toBe(
      'keep for recovery',
    );
  });
});
