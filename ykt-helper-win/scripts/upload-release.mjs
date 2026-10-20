import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'Cyclohexi/yuketang-helper-auto';
const { version } = JSON.parse(
  await readFile(join(root, 'desktop/package.json'), 'utf8'),
);
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('A stable release version is required.');
const tag = `v${version}`;
const directory = join(root, 'desktop/out/release', tag);
const names = [
  `YuketangHelper-v${version}-Windows-x64-Portable.zip`,
  'update-win32-x64.json',
];
if (process.argv.slice(2).some((argument) => argument !== '--publish')) {
  throw new Error('Usage: npm run release:upload -- [--publish]');
}
const publish = process.argv.includes('--publish');
const notes = await readFile(
  join(root, `docs/release-notes-${tag}.md`),
  'utf8',
);
const title = notes.split(/\r?\n/)[0].replace(/^#\s*/, '').trim();
const manifest = JSON.parse(
  await readFile(join(directory, 'update-win32-x64.json'), 'utf8'),
);
const hashes = new Map();
for (const name of names) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, name)))
    hash.update(chunk);
  hashes.set(name, `sha256:${hash.digest('hex')}`);
}
if (
  manifest.version !== version ||
  manifest.file !== names[0] ||
  manifest.size !== (await stat(join(directory, names[0]))).size ||
  `sha256:${manifest.sha256}` !== hashes.get(names[0])
) {
  throw new Error('Portable package does not match its update manifest.');
}
const files = await readdir(directory);
for (const name of names) {
  if (!files.includes(name))
    throw new Error(`Missing ${name}; run npm run release:prepare first.`);
}
function getToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const output = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true,
  });
  const token = /^password=(.+)$/m.exec(output)?.[1]?.trim();
  if (!token) throw new Error('Set GH_TOKEN or configure GitHub credentials.');
  return token;
}
const token = getToken();
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'YuketangHelperReleaseUploader',
};
async function request(path, init = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    { ...init, headers: { ...headers, ...init.headers } },
  );
  if (!response.ok)
    throw new Error(`GitHub request failed: HTTP ${response.status}`);
  return response.json();
}
// Upload a complete portable release as a draft. Only an explicit --publish
// promotes it after both attachments have been verified.
const lookup = await fetch(
  `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
  { headers },
);
let release;
if (lookup.ok) {
  release = await lookup.json();
  if (!release.draft)
    throw new Error(
      `${tag} is already public. Use a new version; public assets will not be overwritten.`,
    );
} else if (lookup.status === 404) {
  await request(`/git/ref/tags/${tag}`);
  release = await request('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: title,
      body: notes,
      draft: true,
      prerelease: false,
    }),
  });
} else throw new Error(`Cannot inspect release: HTTP ${lookup.status}`);
for (const name of names) {
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) {
    if (
      existing.digest !== hashes.get(name) ||
      existing.size !== (await stat(join(directory, name))).size
    ) {
      throw new Error(
        `Draft asset ${name} differs from the local file. Inspect the draft before retrying.`,
      );
    }
    console.log(`Verified existing ${name}`);
    continue;
  }
  const path = join(directory, name);
  const response = await fetch(
    `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String((await stat(path)).size),
      },
      body: createReadStream(path),
      duplex: 'half',
    },
  );
  if (!response.ok)
    throw new Error(
      `Upload ${name} failed: HTTP ${response.status}. Release remains a draft.`,
    );
  console.log(`Uploaded ${name}`);
}
const verified = await request(`/releases/${release.id}`);
for (const name of names) {
  const asset = verified.assets.find((item) => item.name === name);
  if (
    !asset ||
    asset.digest !== hashes.get(name) ||
    asset.size !== (await stat(join(directory, name))).size
  ) {
    throw new Error(
      `Uploaded asset ${name} failed verification; release remains a draft.`,
    );
  }
}
if (verified.assets.some((asset) => !names.includes(asset.name))) {
  throw new Error(
    'Draft contains unexpected attachments. Only the portable ZIP and update manifest may be published.',
  );
}
if (publish) {
  release = await request(`/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    }),
  });
  console.log(`Published: ${release.html_url}`);
} else console.log(`Draft ready for review: ${release.html_url}`);
