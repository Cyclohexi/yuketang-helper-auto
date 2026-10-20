import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppUpdateState } from '@ykt/contracts';

import {
  launchPortableUpdate,
  preparePortableUpdate,
  type PortableUpdateJob,
} from './portable-update.js';
import {
  isNewerVersion,
  MANIFEST_NAME,
  parsePortableManifest,
  parseRelease,
  RELEASE_API,
  releaseDownloadBase,
  type PortableManifest,
  type UpdateRelease,
} from './update-release.js';

export interface NativeUpdateDriver extends Pick<
  EventEmitter,
  'on' | 'removeListener'
> {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export interface AppUpdateOptions {
  version: string;
  mode: AppUpdateState['mode'];
  executable: string;
  directory: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  onState: (state: AppUpdateState) => void;
  beforeInstall: () => Promise<void>;
  quit: () => void;
  nativeUpdater: NativeUpdateDriver;
  preparePortable?: (job: PortableUpdateJob) => Promise<void>;
  launchPortable?: (directory: string) => Promise<void>;
}

export class AppUpdateController {
  #state: AppUpdateState;
  #release: UpdateRelease | undefined;
  #manifest: PortableManifest | undefined;
  #jobDirectory: string | undefined;
  #busy = false;
  #nativeBusy = false;
  #initialTimer: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #abort: AbortController | undefined;
  #disposed = false;
  readonly #nativeListeners: Array<[string, (...args: any[]) => void]>;

  constructor(private readonly options: AppUpdateOptions) {
    this.#state = {
      phase: options.mode === 'unsupported' ? 'disabled' : 'idle',
      mode: options.mode,
      currentVersion: options.version,
      message:
        options.mode === 'unsupported'
          ? '自动更新仅支持 Windows x64 安装版或便携版，开发模式不检查更新。'
          : '启动后自动检查更新，也可手动检查。',
    };
    this.#nativeListeners = [
      [
        'error',
        (error: Error) => {
          if (!this.#nativeBusy) return;
          this.#nativeBusy = false;
          this.fail(error);
        },
      ],
      [
        'update-not-available',
        () => {
          if (!this.#nativeBusy) return;
          this.#nativeBusy = false;
          this.set({ phase: 'current', message: '当前已是最新可安装版本。' });
        },
      ],
      [
        'update-downloaded',
        () => {
          if (!this.#nativeBusy) return;
          this.#nativeBusy = false;
          this.set({
            phase: 'ready',
            message: '更新已下载，重启即可完成安装。',
          });
        },
      ],
    ];
    if (options.mode === 'installed') {
      for (const [event, listener] of this.#nativeListeners)
        options.nativeUpdater.on(event, listener);
    }
  }

  getState(): AppUpdateState {
    return { ...this.#state };
  }

  async start(): Promise<void> {
    if (this.#state.phase === 'disabled') return;
    await mkdir(this.options.directory, { recursive: true });
    const resultPath = join(this.options.directory, 'result.json');
    try {
      const result = JSON.parse(
        (await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''),
      );
      if (result.success === false) {
        this.set({
          phase: 'error',
          message: `${result.restored === true ? '上次更新失败，已恢复原程序。' : '上次更新未完成，请检查备份并恢复程序。'}${String(result.message).slice(0, 300)}`,
        });
      } else if (result.success === true) {
        this.set({
          phase: 'idle',
          message: `已更新到 ${this.options.version}。`,
        });
      }
      await rm(resultPath, { force: true });
    } catch {
      /* No previous portable update result. */
    }
    if (this.#disposed) return;
    this.#initialTimer = setTimeout(() => {
      void this.check();
    }, 15_000);
    this.#initialTimer.unref();
    this.#interval = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000,
    );
    this.#interval.unref();
  }

  async check(): Promise<AppUpdateState> {
    if (this.blocked() || this.#state.phase === 'ready') return this.getState();
    this.#busy = true;
    this.#release = undefined;
    this.#manifest = undefined;
    this.set({ phase: 'checking', message: '正在检查更新…' });
    try {
      const release = parseRelease(await this.json(RELEASE_API));
      if (!isNewerVersion(release.version, this.options.version)) {
        this.set({ phase: 'current', message: '当前已是最新版本。' });
        return this.getState();
      }
      if (this.options.mode === 'portable') {
        const asset = release.assets.find(
          (item) => item.name === MANIFEST_NAME,
        );
        if (!asset) throw new Error('新版尚未发布便携版更新清单，请稍后重试。');
        this.#manifest = parsePortableManifest(
          await this.json(asset.browser_download_url),
          release,
        );
      } else if (
        !release.assets.some((item) => item.name === 'RELEASES') ||
        !release.assets.some((item) => /-full\.nupkg$/i.test(item.name))
      ) {
        throw new Error('新版尚未发布安装版更新文件，请稍后重试。');
      }
      this.#release = release;
      this.set({
        phase: 'available',
        latestVersion: release.version,
        message: `发现新版 ${release.version}，可在应用内下载更新。`,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.#busy = false;
    }
    return this.getState();
  }

  async download(): Promise<AppUpdateState> {
    if (this.blocked() || this.#state.phase !== 'available' || !this.#release)
      return this.getState();
    this.#busy = true;
    this.set({
      phase: 'downloading',
      message: '正在下载更新，可继续使用应用…',
    });
    try {
      if (this.options.mode === 'installed') {
        this.#nativeBusy = true;
        this.options.nativeUpdater.setFeedURL({
          url: releaseDownloadBase(this.#release.tag),
        });
        this.options.nativeUpdater.checkForUpdates();
      } else {
        const manifest = this.#manifest!;
        await mkdir(this.options.directory, { recursive: true });
        this.#jobDirectory = await mkdtemp(
          join(this.options.directory, 'job-'),
        );
        await this.downloadArchive(manifest, this.#release);
        await (this.options.preparePortable ?? preparePortableUpdate)({
          directory: this.#jobDirectory,
          id: randomUUID(),
          executable: this.options.executable,
          resultPath: join(this.options.directory, 'result.json'),
          version: manifest.version,
          sha256: manifest.sha256,
          size: manifest.size,
        });
        this.set({
          phase: 'ready',
          progress: 100,
          message: '更新已下载并校验，重启后安装；本地数据会保留。',
        });
      }
    } catch (error) {
      this.#nativeBusy = false;
      if (this.#jobDirectory)
        await rm(this.#jobDirectory, { recursive: true, force: true }).catch(
          () => {},
        );
      this.#jobDirectory = undefined;
      this.fail(error);
    } finally {
      this.#busy = false;
    }
    return this.getState();
  }

  async install(): Promise<AppUpdateState> {
    if (this.blocked() || this.#state.phase !== 'ready') return this.getState();
    this.#busy = true;
    this.set({ phase: 'installing', message: '正在关闭应用并安装更新…' });
    try {
      if (this.options.mode === 'portable') {
        // Spawn successfully before shutting services down. The helper waits for
        // this PID to exit, so files cannot be replaced while the app is live.
        await (this.options.launchPortable ?? launchPortableUpdate)(
          this.#jobDirectory!,
        );
      }
      await this.options.beforeInstall();
      if (this.options.mode === 'installed')
        this.options.nativeUpdater.quitAndInstall();
      else this.options.quit();
    } catch (error) {
      this.fail(error);
    } finally {
      this.#busy = false;
    }
    return this.getState();
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#initialTimer);
    clearInterval(this.#interval);
    this.#abort?.abort();
    if (this.options.mode === 'installed') {
      for (const [event, listener] of this.#nativeListeners)
        this.options.nativeUpdater.removeListener(event, listener);
    }
  }

  private blocked(): boolean {
    return (
      this.#disposed ||
      this.#busy ||
      this.#nativeBusy ||
      this.#state.phase === 'disabled' ||
      this.#state.phase === 'installing'
    );
  }

  private async json(url: string): Promise<unknown> {
    this.#abort = new AbortController();
    const response = await this.options.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'YuketangHelper-Updater',
      },
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(30_000),
      ]),
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(
        `更新源访问失败（HTTP ${response.status}），请检查网络后重试。`,
      );
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('更新源响应过大。');
    return JSON.parse(text);
  }

  private async downloadArchive(
    manifest: PortableManifest,
    release: UpdateRelease,
  ): Promise<void> {
    this.#abort = new AbortController();
    const response = await this.options.fetch(
      `${releaseDownloadBase(release.tag)}/${manifest.file}`,
      {
        signal: AbortSignal.any([
          this.#abort.signal,
          AbortSignal.timeout(15 * 60 * 1000),
        ]),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`更新包下载失败（HTTP ${response.status}）。`);
    const file = await open(join(this.#jobDirectory!, 'update.zip'), 'wx');
    const hash = createHash('sha256');
    let size = 0;
    let lastProgress = -1;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > manifest.size) throw new Error('更新包超出清单声明大小。');
        hash.update(value);
        await file.writeFile(value);
        const progress = Math.floor((size * 100) / manifest.size);
        if (progress !== lastProgress) {
          lastProgress = progress;
          this.set({
            ...this.#state,
            progress,
            message: `正在下载更新 ${progress}%…`,
          });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await file.close();
    }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) {
      throw new Error('更新包完整性校验失败，已取消更新，请重试。');
    }
  }

  private fail(error: unknown): void {
    this.set({
      phase: 'error',
      message: `更新失败：${error instanceof Error ? error.message.slice(0, 500) : '请检查网络后重试。'}`,
    });
  }

  private set(
    patch: Pick<AppUpdateState, 'phase' | 'message'> & Partial<AppUpdateState>,
  ): void {
    if (this.#disposed) return;
    this.#state = {
      currentVersion: this.options.version,
      mode: this.options.mode,
      ...(this.#release ? { latestVersion: this.#release.version } : {}),
      ...patch,
    };
    this.options.onState(this.getState());
  }
}
