import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const core = join(repository, 'ykt-helper-win');
function git(...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
}
const arguments_ = process.argv.slice(2);
if (
  arguments_.length &&
  (arguments_.length !== 2 || arguments_[0] !== '--base')
) {
  throw new Error('Usage: npm run sync:check -- [--base <commit>]');
}
const memoryFiles = ['AGENTS.md', 'ykt-helper-win/docs/project-maintenance.md'];
for (const path of memoryFiles) {
  if (!(await readFile(join(repository, path), 'utf8')).trim())
    throw new Error(`项目记忆为空：${path}`);
}
console.log('已读取项目记忆：AGENTS.md、docs/project-maintenance.md');
let base = arguments_[1];
if (!base) {
  try {
    base = git('rev-parse', '--verify', '@{upstream}').trim();
  } catch {
    base = 'HEAD';
  }
}
const changed = new Set(
  [
    ...git('diff', '--name-only', '-z', base, '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean),
);
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const issues = [];
for (const path of tracked) {
  if (
    /(^|\/)(user-data-backups|ykt-helper-data|YuketangHelper|YuketangHelper-debug|node_modules)(\/|$)/.test(
      path,
    )
  ) {
    issues.push(`真实数据或依赖不可提交：${path}`);
  }
}
const packagePaths = [
  'package.json',
  'apps/cli/package.json',
  'apps/desktop/package.json',
  'desktop/package.json',
  'packages/backend/package.json',
  'packages/contracts/package.json',
  'packages/routing/package.json',
  'packages/storage/package.json',
];
const rootPackage = JSON.parse(
  await readFile(join(core, 'package.json'), 'utf8'),
);
for (const path of packagePaths) {
  const pkg = JSON.parse(await readFile(join(core, path), 'utf8'));
  if (pkg.version !== rootPackage.version) issues.push(`版本号不一致：${path}`);
}
const lock = JSON.parse(
  await readFile(join(core, 'package-lock.json'), 'utf8'),
);
if (
  lock.version !== rootPackage.version ||
  lock.packages[''].version !== rootPackage.version
)
  issues.push('锁文件根版本不一致');
for (const path of packagePaths.slice(1)) {
  if (
    lock.packages[dirname(path).replaceAll('\\', '/')]?.version !==
    rootPackage.version
  )
    issues.push(`锁文件工作区版本不一致：${path}`);
}
const rules = [
  {
    source: /^ykt-helper-win\/(?:apps|packages)\/.*\.(?:ts|vue|css)$/,
    docs: ['changelog.md'],
  },
  {
    source:
      /^(?:启动雨课堂助手\.bat|ykt-helper-win\/(?:scripts\/|package\.json))/,
    docs: ['ykt-helper-win/README.md'],
  },
  {
    source: /^ykt-helper-win\/apps\/desktop\/main\/storage-profile\.ts$/,
    docs: [
      'README.md',
      'ykt-helper-win/README.md',
      'PROJECT_KNOWLEDGE_BASE.md',
      'ykt-helper-win/docs/auto-update.md',
    ],
  },
  {
    source:
      /^ykt-helper-win\/(?:apps\/desktop\/main\/(?:app-update-controller|portable-update|update-release)\.ts|desktop\/forge\.config\.cjs|scripts\/(?:prepare-update-release|upload-release|set-release-version)\.mjs)$/,
    docs: ['ykt-helper-win/docs/auto-update.md'],
  },
];
const required = new Set();
for (const path of changed) {
  if (/\.(?:test|spec)\.ts$/.test(path)) continue;
  for (const rule of rules)
    if (rule.source.test(path)) for (const doc of rule.docs) required.add(doc);
}
for (const doc of required)
  if (!changed.has(doc)) issues.push(`本次改动需同步基本说明：${doc}`);
for (const doc of [
  'README.md',
  'changelog.md',
  'PROJECT_KNOWLEDGE_BASE.md',
  'ykt-helper-win/README.md',
  'ykt-helper-win/docs/auto-update.md',
  'ykt-helper-win/desktop/README.md',
]) {
  await readFile(join(repository, doc), 'utf8');
}
console.log(
  `核对 ${changed.size} 个变更文件，版本 ${rootPackage.version}；请按维护清单检查受影响的专项文档。`,
);
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else console.log('项目同步检查通过；提交代码与相关文档后再推送。');
