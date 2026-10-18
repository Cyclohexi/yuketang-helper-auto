import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function getGitToken() {
  const output = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const match = output.match(/password=(.+)/);
  if (!match) throw new Error('Cannot find token in git credential fill');
  return match[1].trim();
}

async function githubRequest(url, options = {}) {
  const token = getGitToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'YuketangHelperReleaseUploader/1.0',
    Accept: 'application/vnd.github.v3+json',
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API Error ${res.status} ${res.statusText} for ${url}: ${text}`);
  }
  return res.json();
}

async function uploadAsset(uploadUrlTemplate, filePath, assetName) {
  const token = getGitToken();
  const stats = fs.statSync(filePath);
  const size = stats.size;
  const uploadUrl = uploadUrlTemplate.replace(/\{\?name,label\}/, `?name=${encodeURIComponent(assetName)}`);

  console.log(`[Upload] Uploading ${assetName} (${(size / 1024 / 1024).toFixed(2)} MB)...`);

  const fileStream = fs.createReadStream(filePath);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'YuketangHelperReleaseUploader/1.0',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: fileStream,
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload ${assetName}: ${res.status} ${res.statusText} - ${text}`);
  }

  const result = await res.json();
  console.log(`[Success] ${assetName} uploaded successfully! Browser URL: ${result.browser_download_url}`);
  return result;
}

async function main() {
  const owner = 'Cyclohexi';
  const repo = 'yuketang-helper-auto';
  const tag = 'v2.1.0';

  console.log(`[Release] Creating / Fetching release ${tag} on ${owner}/${repo}...`);

  let release;
  try {
    release = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
    console.log(`[Release] Release ${tag} already exists (ID: ${release.id})`);
  } catch (err) {
    console.log(`[Release] Release ${tag} does not exist yet, creating...`);
    release = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: '雨课堂助手 v2.1.0 - 智能自动定位开刷与原生防抖版',
        body: `## 🌟 雨课堂助手 v2.1.0 发布说明

欢迎使用雨课堂助手桌面版 v2.1.0！本项目为广大同学和开发者提供了一键式的雨课堂自动化辅助体验，无需配置复杂的开发环境。

### 🚀 本次更新重点：
- **智能目录扫描与免缓存精确定位**：进入课程后自动分析章节树，秒级定位到第一个未完成的学习单元（无论讨论、视频或作业），无需依赖易失效的缓存；
- **原生视频倍速防抖与锁定**：彻底消除页面自身频繁重置倍速的死循环，稳定维持所配置倍速；
- **讨论区智能互动跟帖**：自动获取同班同学优质评论并填充，支持富文本 contenteditable 及防重复提交机制；
- **免安装与一键安装程序**：无需安装 Node.js、npm 或 Python，开箱即用。

### 📦 安装包下载：
- **\`YuketangHelper-Setup.exe\`**：Windows 一键安装版，双击即可全自动安装并在桌面生成图标（推荐广大同学首选）。
- **\`YuketangHelper-v2.1.0-Windows-x64-Portable.zip\`**：绿色便携免安装版，解压后双击 \`雨课堂助手.exe\` 直接运行，数据完全隔离在本地文件夹中。

---
*本项目仅供技术交流与学习研究使用，遵循 MIT 开源协议。*`,
        draft: false,
        prerelease: false,
      }),
    });
    console.log(`[Release] Release created with ID: ${release.id}`);
  }

  // Check existing assets and delete if duplicate
  if (Array.isArray(release.assets)) {
    for (const asset of release.assets) {
      if (asset.name === 'YuketangHelper-Setup.exe' || asset.name === 'YuketangHelper-v2.1.0-Windows-x64-Portable.zip') {
        console.log(`[Asset] Deleting existing asset ${asset.name} (ID: ${asset.id})...`);
        const token = getGitToken();
        await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'YuketangHelperReleaseUploader/1.0',
          },
        });
      }
    }
  }

  const setupExePath = path.join(
    root,
    'desktop',
    'out',
    'make',
    'squirrel.windows',
    'x64',
    'YuketangHelper-Setup.exe',
  );
  const portableZipPath = path.join(
    root,
    'desktop',
    'out',
    'make',
    'YuketangHelper-v2.1.0-Windows-x64-Portable.zip',
  );

  if (fs.existsSync(setupExePath)) {
    await uploadAsset(release.upload_url, setupExePath, 'YuketangHelper-Setup.exe');
  } else {
    console.error(`[Error] Setup file not found at ${setupExePath}`);
  }

  if (fs.existsSync(portableZipPath)) {
    await uploadAsset(release.upload_url, portableZipPath, 'YuketangHelper-v2.1.0-Windows-x64-Portable.zip');
  } else {
    console.error(`[Error] Portable zip not found at ${portableZipPath}`);
  }

  console.log(`\n🎉 All assets uploaded successfully! Release URL: ${release.html_url}`);
}

main().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
