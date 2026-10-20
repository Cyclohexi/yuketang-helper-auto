import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version, productName, name } = JSON.parse(
  await readFile(join(root, 'desktop/package.json'), 'utf8'),
);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  throw new Error('A stable x.y.z version is required.');
const output = join(root, 'desktop/out/release', `v${version}`);
const zipDirectory = join(root, 'desktop/out/make/zip/win32/x64');
const zipPath = join(
  zipDirectory,
  `${productName || name}-win32-x64-${version}.zip`,
);
const sha256 = createHash('sha256');
for await (const chunk of createReadStream(zipPath)) sha256.update(chunk);
await mkdir(output, { recursive: true });
const portableName = `YuketangHelper-v${version}-Windows-x64-Portable.zip`;
await copyFile(zipPath, join(output, portableName));
await writeFile(
  join(output, 'update-win32-x64.json'),
  `${JSON.stringify(
    {
      version,
      file: portableName,
      size: (await stat(zipPath)).size,
      sha256: sha256.digest('hex'),
    },
    null,
    2,
  )}\n`,
);
console.log(`Update-ready release files: ${output}`);
