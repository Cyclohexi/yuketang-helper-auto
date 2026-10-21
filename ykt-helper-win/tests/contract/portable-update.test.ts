import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  launchPortableUpdate,
  preparePortableUpdate,
} from '../../apps/desktop/main/portable-update.js';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) =>
        rm(path, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }),
      ),
  );
});
async function powershell(script: string, args: string[] = []) {
  return exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args,
    ],
    { windowsHide: true, timeout: 30_000 },
  );
}
async function fixture(extra: Record<string, string> = {}, renamed = false) {
  const root = await mkdtemp(join(tmpdir(), "ykt-更新 'test-"));
  directories.push(root);
  const directory = join(root, 'job');
  const target = join(root, 'app');
  await mkdir(directory);
  await mkdir(join(target, 'resources'), { recursive: true });
  await mkdir(join(target, 'ykt-helper-data'), { recursive: true });
  const exeName = renamed ? '雨课堂助手.exe' : 'YuketangHelper.exe';
  await writeFile(join(target, exeName), 'old exe');
  await writeFile(join(target, 'resources/app.asar'), 'old application');
  await writeFile(
    join(target, 'ykt-helper-data/settings.json'),
    'precious settings',
  );
  await writeFile(join(target, 'notes.txt'), 'personal notes');
  const entries = {
    'YuketangHelper.exe': 'new exe',
    'resources/app.asar': 'new application',
    'portable.flag': 'portable',
    ...extra,
  };
  await writeFile(join(directory, 'entries.json'), JSON.stringify(entries));
  const makeZip = join(directory, 'zip.ps1');
  await writeFile(
    makeZip,
    String.raw`
param([string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entries = Get-Content -LiteralPath (Join-Path $Directory 'entries.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::Open((Join-Path $Directory 'update.zip'), 'Create')
try {
  foreach ($property in $entries.PSObject.Properties) {
    $entry = $zip.CreateEntry($property.Name)
    $writer = New-Object IO.StreamWriter($entry.Open())
    try { $writer.Write($property.Value) } finally { $writer.Dispose() }
  }
} finally { $zip.Dispose() }
`,
  );
  await powershell(makeZip, ['-Directory', directory]);
  const bytes = await readFile(join(directory, 'update.zip'));
  const job = {
    directory,
    id: randomUUID(),
    executable: join(target, exeName),
    resultPath: join(root, 'result.json'),
    version: '2.3.0',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { root, directory, target, job };
}
async function apply(directory: string, failCopy = false) {
  const path = join(directory, 'job.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.parentPid = 0; // Test fixture contains text files, not a running application.
  await writeFile(path, JSON.stringify(config));
  if (failCopy) {
    const wrapper = join(directory, 'fail-copy.ps1');
    await writeFile(
      wrapper,
      String.raw`
param([string]$Directory)
function Copy-Item { throw 'Injected disk write failure.' }
& (Join-Path $Directory 'updater.ps1') -ConfigPath (Join-Path $Directory 'job.json') -Mode apply -NoRestart
exit $LASTEXITCODE
`,
    );
    return powershell(wrapper, ['-Directory', directory]);
  }
  return powershell(join(directory, 'updater.ps1'), [
    '-ConfigPath',
    path,
    '-Mode',
    'apply',
    '-NoRestart',
  ]);
}

describe.runIf(process.platform === 'win32')(
  'Windows portable update helper',
  () => {
    it('updates a renamed executable and preserves user data and unrelated files', async () => {
      const { directory, target, job } = await fixture({}, true);
      await preparePortableUpdate(job);
      expect(await readFile(join(target, 'resources/app.asar'), 'utf8')).toBe(
        'old application',
      );
      await apply(directory);
      expect(await readFile(job.executable, 'utf8')).toBe('new exe');
      expect(await readFile(join(target, 'resources/app.asar'), 'utf8')).toBe(
        'new application',
      );
      expect(
        await readFile(join(target, 'ykt-helper-data/settings.json'), 'utf8'),
      ).toBe('precious settings');
      expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe(
        'personal notes',
      );
      expect(
        JSON.parse(
          (await readFile(job.resultPath, 'utf8')).replace(/^\uFEFF/, ''),
        ).success,
      ).toBe(true);
    }, 30_000);
    it('rolls back replaced entries when copying the new application fails', async () => {
      const { directory, target, job } = await fixture();
      await preparePortableUpdate(job);
      await expect(apply(directory, true)).rejects.toThrow();
      expect(await readFile(job.executable, 'utf8')).toBe('old exe');
      expect(await readFile(join(target, 'resources/app.asar'), 'utf8')).toBe(
        'old application',
      );
      expect(
        await readFile(join(target, 'ykt-helper-data/settings.json'), 'utf8'),
      ).toBe('precious settings');
      expect(
        JSON.parse(
          (await readFile(job.resultPath, 'utf8')).replace(/^\uFEFF/, ''),
        ).success,
      ).toBe(false);
    }, 30_000);
    it.each([
      '../escaped.txt',
      'ykt-helper-data/settings.json',
      'C:/escaped.txt',
    ])(
      'rejects unsafe or data-bearing archive entry %s before replacing files',
      async (name) => {
        const { target, job } = await fixture({ [name]: 'malicious' });
        await expect(preparePortableUpdate(job)).rejects.toThrow(
          name.startsWith('ykt-helper-data')
            ? /Unexpected archive entry/
            : /Unsafe archive path|escapes/,
        );
        expect(await readFile(job.executable, 'utf8')).toBe('old exe');
        expect(
          await readFile(join(target, 'ykt-helper-data/settings.json'), 'utf8'),
        ).toBe('precious settings');
      },
      30_000,
    );
    it('rechecks the archive hash in the helper before extracting it', async () => {
      const { job } = await fixture();
      await expect(
        preparePortableUpdate({ ...job, sha256: '0'.repeat(64) }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(await readFile(job.executable, 'utf8')).toBe('old exe');
    }, 30_000);
    it('acknowledges startup and survives the real caller exiting before applying', async () => {
      const { directory, job, target } = await fixture({}, true);
      await preparePortableUpdate(job);
      const script = join(directory, 'updater.ps1');
      await writeFile(
        script,
        (await readFile(script, 'utf8')).replace(
          "$ErrorActionPreference = 'Stop'",
          "$NoRestart = $true\n$ErrorActionPreference = 'Stop'",
        ),
      ); // Fixture executables are text; real GUI restart is separately verified.
      const moduleUrl = pathToFileURL(
        join(process.cwd(), 'apps/desktop/main/portable-update.ts'),
      ).href;
      const childCode = `
        import { readFile, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const { launchPortableUpdate } = await import(${JSON.stringify(moduleUrl)});
        const directory = process.argv[1];
        const file = join(directory, 'job.json');
        const config = JSON.parse(await readFile(file, 'utf8'));
        config.parentPid = process.pid;
        await writeFile(file, JSON.stringify(config));
        await launchPortableUpdate(directory);
        process.exit(0);
      `;
      await exec(
        process.execPath,
        ['--input-type=module', '-e', childCode, directory],
        { windowsHide: true, timeout: 20_000 },
      );
      await vi.waitFor(
        async () => {
          const result = JSON.parse(
            (await readFile(job.resultPath, 'utf8')).replace(/^\uFEFF/, ''),
          );
          expect(result.success).toBe(true);
          expect(await readFile(job.executable, 'utf8')).toBe('new exe');
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(
        await readFile(join(target, 'ykt-helper-data/settings.json'), 'utf8'),
      ).toBe('precious settings');
      const log = await readFile(
        join(target, '..', `installer-${job.id}.log`),
        'utf8',
      );
      expect(log).toContain('waiting-for-application-exit');
      expect(log).toContain('installed');
    }, 30_000);
    it('rejects a worker that exits without acknowledging instead of allowing app shutdown', async () => {
      const { directory, job } = await fixture();
      await preparePortableUpdate(job);
      await writeFile(join(directory, 'updater.ps1'), 'exit 0');
      const failed = expect(launchPortableUpdate(directory)).rejects.toThrow(
        '未就绪',
      );
      await vi.waitFor(
        async () => {
          expect(
            (await readFile(join(directory, 'launch.log'), 'utf8')).length,
          ).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(15_100);
      await failed;
      expect(await readFile(job.executable, 'utf8')).toBe('old exe');
    }, 30_000);
  },
);
