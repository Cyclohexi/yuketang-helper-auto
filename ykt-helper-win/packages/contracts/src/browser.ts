export const BrowserEnvironment = {
  Standard: 'standard',
  Pro: 'pro',
  Changjiang: 'changjiang',
} as const;

export type BrowserEnvironment =
  (typeof BrowserEnvironment)[keyof typeof BrowserEnvironment];

export interface BrowserTarget {
  id: BrowserEnvironment;
  label: string;
  startUrl: string;
}

export const BrowserTargets: readonly BrowserTarget[] = [
  {
    id: BrowserEnvironment.Standard,
    label: '雨课堂',
    startUrl: 'https://www.yuketang.cn/web',
  },
  {
    id: BrowserEnvironment.Pro,
    label: '荷塘雨课堂',
    startUrl: 'https://pro.yuketang.cn/web',
  },
  {
    id: BrowserEnvironment.Changjiang,
    label: '长江雨课堂',
    startUrl: 'https://changjiang.yuketang.cn/web',
  },
];

export interface BrowserTabState {
  id: string;
  environment: BrowserEnvironment;
  url: string;
  title: string;
  loading: boolean;
}

export interface BrowserState {
  tabs: readonly BrowserTabState[];
  activeTabId: string;
  environment: BrowserEnvironment;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  errorMessage: string | null;
  assistantPanelCollapsed: boolean;
  networkLabCollapsed: boolean;
}

export function isBrowserEnvironment(
  value: unknown,
): value is BrowserEnvironment {
  return BrowserTargets.some((target) => target.id === value);
}

export function lessonIdFromBrowserUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.hostname !== 'yuketang.cn' &&
      !url.hostname.endsWith('.yuketang.cn')
    ) {
      return null;
    }
    const patterns = [
      /\/lesson\/fullscreen\/v3\/([^/]+)/,
      /\/m\/v2\/lesson\/student\/([^/]+)/,
      /\/v2\/web\/lesson\/([^/]+)/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(url.pathname);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return null;
  } catch {
    return null;
  }
}
