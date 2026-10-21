import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
import {
  downloadUpdateArchive,
  retryableUpdateError,
  UpdateTransferError,
  updateHttpError,
  waitForUpdateRetry,
} from './update-download.js';

export interface AppUpdateOptions {
  version: string;
  mode: AppUpdateState['mode'];
  executable: string;
  directory: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  onState: (state: AppUpdateState) => void;
  beforeInstall: () => Promise<void>;
  quit: () => void;
  preparePortable?: (job: PortableUpdateJob) => Promise<void>;
  launchPortable?: (directory: string) => Promise<void>;
}

export class AppUpdateController {
  #state: AppUpdateState;
  #release: UpdateRelease | undefined;
  #manifest: PortableManifest | undefined;
  #jobDirectory: string | undefined;
  #busy = false;
  #initialTimer: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #abort: AbortController | undefined;
  #disposed = false;

  constructor(private readonly options: AppUpdateOptions) {
    this.#state = {
      phase: options.mode === 'unsupported' ? 'disabled' : 'idle',
      mode: options.mode,
      currentVersion: options.version,
      message:
        options.mode === 'unsupported'
          ? '自动更新支持 Windows x64 便携版，开发模式不检查更新。'
          : '启动后自动检查更新，也可手动检查。',
    };
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
      const asset = release.assets.find((item) => item.name === MANIFEST_NAME);
      if (!asset) throw new Error('新版尚未发布便携版更新清单，请稍后重试。');
      this.#manifest = parsePortableManifest(
        await this.json(asset.browser_download_url),
        release,
      );
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
    if (
      this.blocked() ||
      !this.#release ||
      !this.#manifest ||
      (this.#state.phase !== 'available' &&
        !(this.#state.phase === 'error' && this.#state.progress !== undefined))
    )
      return this.getState();
    this.#busy = true;
    this.set({
      phase: 'downloading',
      message: '正在下载更新，可继续使用应用…',
    });
    try {
      const manifest = this.#manifest!;
      await mkdir(this.options.directory, { recursive: true });
      this.#jobDirectory = await mkdtemp(join(this.options.directory, 'job-'));
      await this.downloadArchive(manifest, this.#release);
      this.#abort?.signal.throwIfAborted();
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
    } catch (error) {
      if (this.#jobDirectory)
        await rm(this.#jobDirectory, { recursive: true, force: true }).catch(
          () => {},
        );
      this.#jobDirectory = undefined;
      this.fail(
        error,
        error instanceof UpdateTransferError && error.discardPartial
          ? 0
          : (this.#state.progress ?? 0),
      );
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
      // Spawn successfully before shutting services down. The helper waits for
      // this PID to exit, so files cannot be replaced while the app is live.
      await (this.options.launchPortable ?? launchPortableUpdate)(
        this.#jobDirectory!,
      );
      await this.options.beforeInstall();
      this.options.quit();
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
  }

  private blocked(): boolean {
    return (
      this.#disposed ||
      this.#busy ||
      this.#state.phase === 'disabled' ||
      this.#state.phase === 'installing'
    );
  }

  private async json(url: string): Promise<unknown> {
    this.#abort = new AbortController();
    for (let attempt = 0; ; attempt++) {
      this.#abort.signal.throwIfAborted();
      try {
        return await this.jsonAttempt(url, this.#abort.signal);
      } catch (error) {
        this.#abort.signal.throwIfAborted();
        if (
          attempt >= 2 ||
          !retryableUpdateError(error) ||
          error instanceof SyntaxError
        )
          throw error;
        await waitForUpdateRetry(1000 * (attempt + 1), this.#abort.signal);
      }
    }
  }

  private async jsonAttempt(
    url: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.options.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'YuketangHelper-Updater',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      cache: 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw updateHttpError(response.status);
    }
    const text = await response.text();
    if (text.length > 1024 * 1024)
      throw new UpdateTransferError('更新源响应过大。');
    return JSON.parse(text);
  }

  private async downloadArchive(
    manifest: PortableManifest,
    release: UpdateRelease,
  ): Promise<void> {
    this.#abort = new AbortController();
    const path = await downloadUpdateArchive({
      manifest,
      url: `${releaseDownloadBase(release.tag)}/${manifest.file}`,
      directory: this.options.directory,
      fetch: this.options.fetch,
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(45 * 60 * 1000),
      ]),
      onProgress: (progress) => {
        if (this.#state.progress !== progress || this.#state.retryAttempt)
          this.set({
            phase: 'downloading',
            progress,
            message: `正在下载更新 ${progress}%…`,
          });
      },
      onRetry: (progress, attempt, milliseconds) =>
        this.set({
          phase: 'downloading',
          progress,
          retryAttempt: attempt,
          message: `网络波动，已保留 ${progress}%：${milliseconds / 1000} 秒后自动重试（${attempt}/5）…`,
        }),
    });
    await copyFile(path, join(this.#jobDirectory!, 'update.zip'));
  }

  private fail(error: unknown, progress?: number): void {
    this.set({
      phase: 'error',
      ...(progress === undefined ? {} : { progress }),
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
