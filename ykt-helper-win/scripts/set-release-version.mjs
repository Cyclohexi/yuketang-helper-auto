import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
  throw new Error('Usage: npm run version:set -- <x.y.z>');
}
const directories = ['', 'desktop'];
for (const parent of ['apps', 'packages']) {
  for (const entry of await readdir(join(root, parent), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
  }
}
function updatePackage(value) {
  value.version = version;
  for (const dependencies of [value.dependencies, value.devDependencies]) {
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@ykt/')) dependencies[name] = version;
    }
  }
}
for (const directory of directories) {
  const path = join(root, directory, 'package.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  updatePackage(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
const lockPath = join(root, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = version;
for (const directory of directories) {
  if (!lock.packages[directory])
    throw new Error(`Missing lockfile workspace: ${directory}`);
  updatePackage(lock.packages[directory]);
}
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Workspace and lockfile versions set to ${version}.`);
