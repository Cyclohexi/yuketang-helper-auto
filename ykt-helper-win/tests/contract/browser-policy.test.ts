import {
  BrowserEnvironment,
  lessonIdFromBrowserUrl,
} from '@ykt/contracts';
import { describe, expect, it } from 'vitest';

import {
  environmentForUrl,
  isAllowedYuketangUrl,
  isClassroomUrl,
  preferredBrowserEnvironment,
  resolveYuketangNavigation,
  targetForEnvironment,
} from '../../apps/desktop/main/browser-policy.js';

describe('embedded browser policy', () => {
  it.each([
    'https://www.yuketang.cn/web',
    'https://pro.yuketang.cn/web',
    'https://changjiang.yuketang.cn/v2/web/index',
    'https://school.yuketang.cn/',
  ])('allows Yuketang HTTPS navigation: %s', (url) => {
    expect(isAllowedYuketangUrl(url)).toBe(true);
  });

  it.each([
    'http://www.yuketang.cn/web',
    'https://yuketang.cn.example.com/',
    'file:///C:/Windows/System32/config',
    'javascript:alert(1)',
    'not a url',
  ])('rejects navigation outside the trusted origin: %s', (url) => {
    expect(isAllowedYuketangUrl(url)).toBe(false);
  });

  it('maps the three environment entry points', () => {
    expect(targetForEnvironment(BrowserEnvironment.Changjiang).startUrl).toBe(
      'https://changjiang.yuketang.cn/web',
    );
    expect(environmentForUrl('https://pro.yuketang.cn/v2/web/index')).toBe(
      BrowserEnvironment.Pro,
    );
  });

  it('prefers the only authenticated environment over a stale saved target', () => {
    expect(
      preferredBrowserEnvironment(BrowserEnvironment.Standard, [
        null,
        null,
        {
          environment: BrowserEnvironment.Changjiang,
          updatedAt: '2026-09-22T12:31:13.221Z',
        },
      ]),
    ).toBe(BrowserEnvironment.Changjiang);
  });

  it('keeps a configured environment when it has a stored user', () => {
    expect(
      preferredBrowserEnvironment(BrowserEnvironment.Standard, [
        {
          environment: BrowserEnvironment.Standard,
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
        {
          environment: BrowserEnvironment.Changjiang,
          updatedAt: '2026-09-22T00:00:00.000Z',
        },
      ]),
    ).toBe(BrowserEnvironment.Standard);
  });

  it('recognizes only classroom routes for the screen wake lock', () => {
    expect(
      isClassroomUrl('https://pro.yuketang.cn/lesson/fullscreen/v3/123'),
    ).toBe(true);
    expect(
      isClassroomUrl('https://www.yuketang.cn/m/v2/lesson/student/123'),
    ).toBe(true);
    expect(isClassroomUrl('https://pro.yuketang.cn/web')).toBe(false);
  });

  it('extracts the classroom id from live and archived classroom pages', () => {
    expect(
      lessonIdFromBrowserUrl(
        'https://changjiang.yuketang.cn/lesson/fullscreen/v3/1781937383609879552/exercise/9',
      ),
    ).toBe('1781937383609879552');
    expect(
      lessonIdFromBrowserUrl(
        'https://pro.yuketang.cn/m/v2/lesson/student/1764118559357124352/overview',
      ),
    ).toBe('1764118559357124352');
    expect(lessonIdFromBrowserUrl('https://example.com/lesson/1')).toBeNull();
  });

  it('resolves address bar input without leaving Yuketang', () => {
    expect(
      resolveYuketangNavigation(
        'pro.yuketang.cn/web',
        'https://pro.yuketang.cn/lesson/1',
      ),
    ).toBe('https://pro.yuketang.cn/web');
    expect(
      resolveYuketangNavigation('/web', 'https://pro.yuketang.cn/lesson/1'),
    ).toBe('https://pro.yuketang.cn/web');
    expect(() =>
      resolveYuketangNavigation(
        'https://example.com',
        'https://pro.yuketang.cn/web',
      ),
    ).toThrow('只能打开雨课堂 HTTPS 地址');
  });
});
