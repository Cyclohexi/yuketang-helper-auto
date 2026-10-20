// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState, DesktopApi } from '@ykt/contracts';
import AppUpdateControl from '../../apps/desktop/renderer/src/components/AppUpdateControl.vue';

let app: App | undefined;
const originalApi = window.yuketang;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  window.yuketang = originalApi;
  vi.restoreAllMocks();
});
async function mount(phase: AppUpdateState['phase']) {
  const state: AppUpdateState = {
    phase,
    mode: 'portable',
    currentVersion: '2.2.0',
    latestVersion: '2.3.0',
    message: '更新状态',
  };
  let notify!: (state: AppUpdateState) => void;
  const unsubscribe = vi.fn();
  const api = {
    getAppUpdateState: vi.fn(async () => state),
    onAppUpdateStateChanged: vi.fn((listener) => {
      notify = listener;
      return unsubscribe;
    }),
    checkAppUpdate: vi.fn(async () => state),
    downloadAppUpdate: vi.fn(async () => ({ ...state, phase: 'ready' })),
    installAppUpdate: vi.fn(async () => ({ ...state, phase: 'installing' })),
  };
  window.yuketang = api as unknown as DesktopApi;
  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(AppUpdateControl) });
  app.mount(host);
  await nextTick();
  await nextTick();
  return {
    host,
    api,
    unsubscribe,
    notify: (patch: Partial<AppUpdateState>) => notify({ ...state, ...patch }),
  };
}
describe('app update control', () => {
  it('offers download in the toolbar and reflects ready events', async () => {
    const { host, api, notify } = await mount('available');
    expect(host.textContent).toContain('下载新版 2.3.0');
    host.querySelector('button')!.click();
    await nextTick();
    await nextTick();
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('重启更新');
    notify({ phase: 'downloading', progress: 42 });
    await nextTick();
    expect(host.textContent).toContain('下载 42%');
    expect(host.querySelector('button')!.disabled).toBe(true);
  });
  it('requires confirmation before closing ongoing work', async () => {
    const { host, api } = await mount('ready');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    host.querySelector('button')!.click();
    await nextTick();
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    host.querySelector('button')!.click();
    await nextTick();
    await nextTick();
    expect(api.installAppUpdate).toHaveBeenCalledOnce();
  });
  it('hides unsupported modes and unsubscribes when removed', async () => {
    const { host, unsubscribe } = await mount('disabled');
    expect(host.querySelector('button')).toBeNull();
    app!.unmount();
    app = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('makes failed checks retryable', async () => {
    const { host, api } = await mount('error');
    expect(host.textContent).toContain('重试');
    host.querySelector('button')!.click();
    await nextTick();
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
  });
});
