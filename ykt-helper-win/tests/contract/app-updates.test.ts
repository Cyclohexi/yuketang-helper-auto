import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppUpdateController,
  type NativeUpdateDriver,
} from '../../apps/desktop/main/app-update-controller.js';
import {
  isNewerVersion,
  MANIFEST_NAME,
  parsePortableManifest,
  parseRelease,
  releaseDownloadBase,
} from '../../apps/desktop/main/update-release.js';

const directories: string[] = [];
const controllers: AppUpdateController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
const version = '2.3.0';
const zipName = `YuketangHelper-v${version}-Windows-x64-Portable.zip`;
const archive = Buffer.from('portable archive bytes');
const manifest = {
  version,
  file: zipName,
  size: archive.length,
  sha256: createHash('sha256').update(archive).digest('hex'),
};
function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      MANIFEST_NAME,
      zipName,
      'RELEASES',
      `YuketangHelper-${version}-full.nupkg`,
    ].map((name) => ({
      name,
      size: name === zipName ? archive.length : 100,
      browser_download_url: `${releaseDownloadBase(`v${version}`)}/${name}`,
    })),
    ...overrides,
  };
}
async function setup(
  mode: 'portable' | 'installed' | 'unsupported' = 'portable',
  content: Uint8Array = archive,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ykt-updates-test-'));
  directories.push(directory);
  const driver = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const options = {
    version: '2.2.0',
    mode,
    executable: join(directory, 'app', 'YuketangHelper.exe'),
    directory,
    fetch: vi.fn(async (url: string) =>
      url.endsWith('.zip')
        ? new Response(content as BodyInit)
        : Response.json(url.endsWith('.json') ? manifest : release()),
    ),
    nativeUpdater: driver as NativeUpdateDriver,
    onState: vi.fn(),
    beforeInstall: vi.fn(async () => {}),
    quit: vi.fn(),
    preparePortable: vi.fn(async () => {}),
    launchPortable: vi.fn(async () => {}),
  };
  const controller = new AppUpdateController(options);
  controllers.push(controller);
  return { controller, options, driver };
}

describe('update release validation', () => {
  it('compares numeric stable versions without downgrade or lexical mistakes', () => {
    expect(isNewerVersion('v2.10.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('2.2.0', '2.2.0')).toBe(false);
    expect(isNewerVersion('2.1.0', '2.2.0')).toBe(false);
    expect(() => isNewerVersion('2.3.0-beta.1', '2.2.0')).toThrow();
    expect(() => isNewerVersion('02.3.0', '2.2.0')).toThrow();
  });
  it('rejects draft, prerelease and attachments from another repository', () => {
    expect(() => parseRelease(release({ draft: true }))).toThrow();
    expect(() => parseRelease(release({ prerelease: true }))).toThrow();
    const value = release();
    value.assets[0]!.browser_download_url = 'https://example.com/update.json';
    expect(() => parseRelease(value)).toThrow();
  });
  it('requires the manifest version, hash and exact attachment size to agree', () => {
    const value = parseRelease(release());
    expect(parsePortableManifest(manifest, value)).toEqual(manifest);
    expect(() =>
      parsePortableManifest({ ...manifest, version: '2.4.0' }, value),
    ).toThrow();
    expect(() =>
      parsePortableManifest({ ...manifest, size: 1 }, value),
    ).toThrow();
    expect(() =>
      parsePortableManifest({ ...manifest, sha256: '' }, value),
    ).toThrow();
    expect(() =>
      parsePortableManifest({ ...manifest, file: '../update.zip' }, value),
    ).toThrow();
  });
});

describe('app update lifecycle', () => {
  it('checks automatically after startup, but never downloads or quits without a click', async () => {
    const { controller, options } = await setup();
    vi.useFakeTimers();
    try {
      await controller.start();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(controller.getState()).toMatchObject({
        phase: 'available',
        latestVersion: version,
      });
      expect(options.fetch).toHaveBeenCalledTimes(2);
      expect(options.preparePortable).not.toHaveBeenCalled();
      expect(options.quit).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('downloads a verified package, prepares while running, and installs only explicitly', async () => {
    const { controller, options } = await setup();
    await controller.check();
    await controller.download();
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      progress: 100,
      latestVersion: version,
    });
    const job = options.preparePortable.mock.calls[0]![0] as unknown as {
      directory: string;
    };
    expect(await readFile(join(job.directory, 'update.zip'))).toEqual(archive);
    await controller.check();
    expect(controller.getState().phase).toBe('ready');
    expect(options.quit).not.toHaveBeenCalled();
    await controller.install();
    expect(options.launchPortable).toHaveBeenCalledWith(job.directory);
    expect(options.beforeInstall).toHaveBeenCalledOnce();
    expect(options.quit).toHaveBeenCalledOnce();
  });
  it('rejects tampering before extraction and leaves the app running', async () => {
    const { controller, options } = await setup(
      'portable',
      Buffer.alloc(archive.length),
    );
    await controller.check();
    await controller.download();
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('完整性校验失败'),
    });
    expect(options.preparePortable).not.toHaveBeenCalled();
    await controller.install();
    expect(options.quit).not.toHaveBeenCalled();
    await controller.check();
    expect(controller.getState().phase).toBe('available');
  });
  it('deduplicates simultaneous checks and recovers from network errors', async () => {
    const { controller, options } = await setup();
    let resolve!: (response: Response) => void;
    options.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = controller.check();
    await controller.check();
    expect(options.fetch).toHaveBeenCalledTimes(1);
    resolve(new Response('', { status: 403 }));
    await pending;
    expect(controller.getState().phase).toBe('error');
    await controller.check();
    expect(controller.getState().phase).toBe('available');
  });
  it('does not offer incomplete releases or a downgrade', async () => {
    const { controller, options } = await setup();
    options.fetch.mockResolvedValueOnce(Response.json(release({ assets: [] })));
    await controller.check();
    expect(controller.getState().phase).toBe('error');
    options.fetch.mockResolvedValueOnce(
      Response.json(release({ tag_name: 'v2.1.0', assets: [] })),
    );
    await controller.check();
    expect(controller.getState().phase).toBe('current');
  });
  it('uses the Squirrel feed only after download is requested and waits for ready before quitting', async () => {
    const { controller, options, driver } = await setup('installed');
    await controller.check();
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    await controller.install();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    await controller.download();
    await controller.download();
    expect(driver.setFeedURL).toHaveBeenCalledWith({
      url: releaseDownloadBase(`v${version}`),
    });
    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    driver.emit('update-downloaded');
    expect(controller.getState().phase).toBe('ready');
    await controller.install();
    expect(options.beforeInstall).toHaveBeenCalledOnce();
    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
  });
  it('handles Squirrel download failures and helper startup failure without shutting services down', async () => {
    const installed = await setup('installed');
    await installed.controller.check();
    await installed.controller.download();
    installed.driver.emit('error', new Error('offline'));
    expect(installed.controller.getState().phase).toBe('error');
    const portable = await setup();
    await portable.controller.check();
    await portable.controller.download();
    portable.options.launchPortable.mockRejectedValueOnce(
      new Error('spawn failed'),
    );
    await portable.controller.install();
    expect(portable.controller.getState().phase).toBe('error');
    expect(portable.options.beforeInstall).not.toHaveBeenCalled();
  });
  it('disables development and unsupported package modes', async () => {
    const { controller, options } = await setup('unsupported');
    await controller.start();
    await controller.check();
    await controller.download();
    await controller.install();
    expect(controller.getState().phase).toBe('disabled');
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
