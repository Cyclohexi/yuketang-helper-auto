import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const directories: string[] = [];
const sourceTime = new Date('2020-01-01T00:00:00Z');
const buildTime = new Date('2021-01-01T00:00:00Z');
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function put(
  path: string,
  content = '',
  time = sourceTime,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await utimes(path, time, time);
}

async function fixture(source = true) {
  const root = await mkdtemp(join(tmpdir(), 'ykt 启动 (A&B)!-'));
  directories.push(root);
  const project = join(root, 'ykt-helper-win');
  await mkdir(join(project, 'scripts'), { recursive: true });
  await copyFile(
    join(repository, '启动雨课堂助手.bat'),
    join(root, '启动雨课堂助手.bat'),
  );
  await copyFile(
    join(repository, 'ykt-helper-win/scripts/start-desktop.ps1'),
    join(project, 'scripts/start-desktop.ps1'),
  );
  const mainSource = join(project, 'apps/desktop/main/index.ts');
  const preloadOutput = join(project, 'apps/desktop/dist/preload/index.cjs');
  if (source) {
    await put(join(project, 'node_modules/electron/dist/electron.exe'));
    await put(mainSource, 'source');
    await utimes(dirname(mainSource), sourceTime, sourceTime);
    await put(join(project, 'package.json'), '{}');
    await put(
      join(project, 'apps/desktop/dist/main/index.cjs'),
      'main',
      buildTime,
    );
    await put(preloadOutput, 'preload', buildTime);
    await put(
      join(project, 'apps/desktop/dist/renderer/index.html'),
      'renderer',
      buildTime,
    );
  }
  return { root, project, mainSource, preloadOutput };
}

async function check(root: string): Promise<{
  mode: string;
  executable: string;
  workingDirectory: string;
  buildRequired: boolean;
}> {
  // Execute the actual .bat through cmd, including its quoting and encoding.
  const command = `""${join(root, '启动雨课堂助手.bat')}" -CheckOnly"`;
  const { stdout } = await exec('cmd.exe', ['/d', '/s', '/c', command], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    timeout: 15_000,
  });
  return JSON.parse(stdout.trim());
}

describe.runIf(process.platform === 'win32')('Windows quick launcher', () => {
  it('runs through cmd from a path with Chinese, spaces, parentheses, ampersands and exclamation marks', async () => {
    const { root, project } = await fixture();
    const portable = join(project, 'desktop/out/雨课堂助手-win32-x64');
    await put(join(portable, 'portable.flag'));
    await put(join(portable, 'YuketangHelper.exe'));
    const plan = await check(root);
    expect(plan).toMatchObject({
      mode: 'source',
      buildRequired: false,
      workingDirectory: join(project, 'apps/desktop'),
    });
    expect(plan.executable).toBe(
      join(project, 'node_modules/electron/dist/electron.exe'),
    );
  }, 20_000);
  it('requires a new build after source edits', async () => {
    const { root, mainSource } = await fixture();
    const future = new Date('2022-01-01T00:00:00Z');
    await utimes(mainSource, future, future);
    expect(await check(root)).toMatchObject({
      mode: 'source',
      buildRequired: true,
    });
  }, 20_000);
  it('rebuilds when a required preload bundle is missing', async () => {
    const { root, preloadOutput } = await fixture();
    await unlink(preloadOutput);
    expect(await check(root)).toMatchObject({
      mode: 'source',
      buildRequired: true,
    });
  }, 20_000);
  it.each(['YuketangHelper.exe', '雨课堂助手.exe'])(
    'finds a portable fallback with executable %s',
    async (name) => {
      const { root, project } = await fixture(false);
      const portable = join(project, 'desktop/out/雨课堂助手-win32-x64');
      await put(join(portable, 'portable.flag'));
      await put(join(portable, name));
      expect(await check(root)).toMatchObject({
        mode: 'portable',
        buildRequired: false,
        executable: join(portable, name),
      });
    },
    20_000,
  );
  it('reports missing dependencies without hanging on pause in check mode', async () => {
    const { root } = await fixture(false);
    await expect(check(root)).rejects.toThrow(/npm ci/);
  }, 20_000);
  it('starts a detached hidden worker without retaining the BAT output stream', async () => {
    const { root, project } = await fixture();
    const desktop = join(project, 'apps/desktop');
    const marker = join(desktop, 'started.json');
    const localAppData = join(root, 'local-app-data');
    // Node is a real executable that accepts the same "." entry argument. Its
    // fixture writes a marker instead of opening a GUI or reading user data.
    await copyFile(
      process.execPath,
      join(project, 'node_modules/electron/dist/electron.exe'),
    );
    await put(
      join(desktop, 'package.json'),
      JSON.stringify({ main: 'dist/main/index.cjs' }),
    );
    await put(
      join(desktop, 'dist/main/index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '{}'); console.error('fixture diagnostic');`,
      buildTime,
    );
    const command = `""${join(root, '启动雨课堂助手.bat')}""`;
    const { stdout, stderr } = await exec(
      'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, LOCALAPPDATA: localAppData },
      },
    );
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    const deadline = Date.now() + 10_000;
    let started = false;
    while (Date.now() < deadline) {
      try {
        await readFile(marker);
        started = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(started).toBe(true);
    // Allow the worker's short exit check/transcript to finish before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const logs = await readdir(
      join(localAppData, 'YuketangHelperLauncher/logs'),
    );
    const errorLog = logs.find((name) => name.endsWith('-desktop-error.log'))!;
    expect(
      await readFile(
        join(localAppData, 'YuketangHelperLauncher/logs', errorLog),
        'utf8',
      ),
    ).toContain('fixture diagnostic');
  }, 20_000);
});
