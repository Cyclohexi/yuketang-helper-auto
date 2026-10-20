import {
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StorageProfileOptions {
  appData: string;
  localAppData?: string | undefined;
  executable: string;
  legacyUserData?: string;
  argv: string[];
  platform: NodeJS.Platform;
}

export function storageProfileDirectory(
  options: StorageProfileOptions,
): string {
  const parent =
    options.platform === 'win32'
      ? options.localAppData || resolve(options.appData, '..', 'Local')
      : options.appData;
  const directory = join(parent, 'YuketangHelper');
  return options.argv.includes('--debug-profile')
    ? `${directory}-debug`
    : directory;
}

export function legacyStorageDirectories(
  options: StorageProfileOptions,
): string[] {
  return [
    ...new Set(
      [
        join(dirname(options.executable), 'ykt-helper-data'),
        join(options.appData, '雨课堂助手'),
        join(options.appData, '@ykt', 'desktop'),
        join(options.appData, 'ykt-helper-win'),
        ...(options.legacyUserData ? [options.legacyUserData] : []),
      ].map((directory) => resolve(directory)),
    ),
  ];
}

function legacyProfile(directory: string) {
  const databasePath = join(directory, 'storage', 'yuketang.sqlite');
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const settings = database
      .prepare('SELECT COUNT(*) AS count FROM settings')
      .get()!;
    const users = database
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get()!;
    // A just-opened profile often has one browser setting and no user. Prefer
    // an existing configured profile rather than replacing it with that shell.
    const configured = Number(settings.count) > 1 || Number(users.count) > 0;
    return { directory, configured, modified: statSync(databasePath).mtimeMs };
  } finally {
    database.close();
  }
}

/** Copy once; a pending marker prevents using incomplete migration results. */
export function prepareStorageDirectory(
  directory: string,
  candidates: string[],
  isolated = false,
): string | null {
  const pending = `${directory}.migration-pending.json`;
  if (existsSync(pending)) {
    throw new Error(
      `上次数据迁移尚未完成，请先关闭旧版并从原目录恢复。原始数据未删除，迁移记录：${pending}`,
    );
  }
  if (existsSync(directory)) return null;
  mkdirSync(dirname(directory), { recursive: true });
  if (isolated) {
    mkdirSync(directory, { recursive: true });
    return null;
  }
  const profiles = candidates
    .filter((candidate) => resolve(candidate) !== resolve(directory))
    .map(legacyProfile)
    .filter((profile) => profile !== null)
    .sort(
      (left, right) =>
        Number(right.configured) - Number(left.configured) ||
        right.modified - left.modified,
    );
  const source = profiles[0]?.directory;
  if (!source) {
    mkdirSync(directory, { recursive: true });
    return null;
  }
  const metadata =
    JSON.stringify(
      { from: source, migratedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n';
  // A separate exclusive marker also handles filesystems that cannot rename
  // directories (EXDEV). Existing data is never merged or overwritten.
  writeFileSync(pending, metadata, { flag: 'wx' });
  try {
    cpSync(source, directory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    writeFileSync(join(directory, 'data-migration.json'), metadata);
    // Remove this only after every file and the final record have been written.
    unlinkSync(pending);
  } catch (error) {
    // Keep the marker and partial copy for recovery. A later launch must not
    // mistake the incomplete directory for a valid existing profile.
    throw new Error(
      `用户数据迁移未完成，原始数据保留在 ${source}。请关闭旧版后恢复迁移。`,
      { cause: error },
    );
  }
  return source;
}
