export const UPDATE_REPOSITORY = 'Cyclohexi/yuketang-helper-auto';
export const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const MANIFEST_NAME = 'update-win32-x64.json';
export const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface UpdateRelease {
  version: string;
  tag: string;
  assets: ReleaseAsset[];
}

export interface PortableManifest {
  version: string;
  file: string;
  size: number;
  sha256: string;
}

export function parseVersion(input: string): number[] {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(input);
  if (!match) throw new Error('更新版本号必须为稳定版 x.y.z。');
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error('更新版本号无效。');
  }
  return parts;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const previous = parseVersion(current);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== previous[index]) return next[index]! > previous[index]!;
  }
  return false;
}

export function releaseDownloadBase(tag: string): string {
  parseVersion(tag);
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag}`;
}

export function parseRelease(value: unknown): UpdateRelease {
  if (
    !isRecord(value) ||
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.tag_name !== 'string' ||
    !Array.isArray(value.assets)
  ) {
    throw new Error('更新源未提供有效的正式发行版。');
  }
  const tag = value.tag_name;
  parseVersion(tag);
  const base = releaseDownloadBase(tag);
  const assets: ReleaseAsset[] = value.assets.map((asset: unknown) => {
    if (
      !isRecord(asset) ||
      typeof asset.name !== 'string' ||
      !/^[\w.-]+$/.test(asset.name) ||
      typeof asset.browser_download_url !== 'string' ||
      asset.browser_download_url !== `${base}/${asset.name}` ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > MAX_UPDATE_BYTES
    ) {
      throw new Error('更新附件的地址或大小无效。');
    }
    return {
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
    };
  });
  return { version: tag.replace(/^v/, ''), tag, assets };
}

export function parsePortableManifest(
  value: unknown,
  release: UpdateRelease,
): PortableManifest {
  if (
    !isRecord(value) ||
    value.version !== release.version ||
    typeof value.file !== 'string' ||
    !/^YuketangHelper-[\w.-]+-Portable\.zip$/.test(value.file) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_UPDATE_BYTES
  ) {
    throw new Error('便携版更新清单无效或与发行版不一致。');
  }
  const asset = release.assets.find((item) => item.name === value.file);
  if (!asset || asset.size !== value.size)
    throw new Error('便携版更新包缺失或大小不符。');
  return {
    version: value.version,
    file: value.file,
    size: value.size,
    sha256: value.sha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
