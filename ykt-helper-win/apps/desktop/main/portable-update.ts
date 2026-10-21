import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

// All paths are data in a JSON file, never interpolated into PowerShell code.
// Replacements are restricted to Electron distribution entries; user data and
// unrelated files are never part of the copy/rollback set.
export const PORTABLE_UPDATE_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [ValidateSet('prepare','apply')][string]$Mode = 'prepare',
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$jobRoot = [IO.Path]::GetFullPath((Split-Path -Parent $ConfigPath))
$target = [IO.Path]::GetFullPath($config.target)
$stage = Join-Path $jobRoot 'stage'
$backup = Join-Path $target ('.ykt-update-backup-' + $config.id)
$canonicalExe = 'YuketangHelper.exe'
$exeName = [IO.Path]::GetFileName($config.exeName)
if ($exeName -ne $config.exeName -or $exeName -notmatch '\.exe$') { throw 'Invalid executable name.' }
if ($target -eq [IO.Path]::GetPathRoot($target) -or -not (Test-Path -LiteralPath $target -PathType Container)) {
  throw 'Invalid installation directory.'
}
if ($config.id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid update job.' }
if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'The installation directory cannot be a link.'
}
function Test-AppEntry([string]$name) {
  return $name -match '^(?i:resources|locales|YuketangHelper\.exe|chrome_100_percent\.pak|chrome_200_percent\.pak|resources\.pak|icudtl\.dat|snapshot_blob\.bin|v8_context_snapshot\.bin|version|LICENSE|LICENSES\.chromium\.html|ykt\.cmd|portable\.flag|[a-z0-9_.-]+\.dll|vk_swiftshader_icd\.json)$'
}
if ($Mode -eq 'prepare') {
  # Probe write access before quitting the running app.
  $probe = Join-Path $target ('.ykt-write-probe-' + $config.id)
  [IO.File]::WriteAllText($probe, '')
  Remove-Item -LiteralPath $probe
  $archive = Join-Path $jobRoot 'update.zip'
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $archiveStream = [IO.File]::OpenRead($archive)
  try { $archiveHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
  finally { $archiveStream.Dispose(); $hashAlgorithm.Dispose() }
  if ((Get-Item -LiteralPath $archive).Length -ne $config.size -or
      $archiveHash -ne $config.sha256) {
    throw 'Update archive checksum mismatch.'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    [long]$total = 0
    if ($zip.Entries.Count -gt 20000) { throw 'Too many archive entries.' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/', '\')
      $parts = $name.TrimEnd('\').Split('\')
      if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or
          ($parts | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -match '[. ]$' }) -or
          (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) {
        throw 'Unsafe archive path.'
      }
      $destination = [IO.Path]::GetFullPath((Join-Path $stage $name))
      if (-not $destination.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Archive path escapes staging directory.'
      }
      $total += $entry.Length
      if ($total -gt 2147483648) { throw 'Expanded update is too large.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
  $payload = $stage
  if (-not (Test-Path -LiteralPath (Join-Path $payload $canonicalExe))) {
    $children = @(Get-ChildItem -LiteralPath $stage -Force)
    if ($children.Count -ne 1 -or -not $children[0].PSIsContainer) { throw 'Invalid portable archive layout.' }
    $payload = $children[0].FullName
  }
  if (-not (Test-Path -LiteralPath (Join-Path $payload $canonicalExe) -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $payload 'resources\app.asar') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $payload 'portable.flag') -PathType Leaf)) {
    throw 'The archive is not a portable application.'
  }
  foreach ($entry in Get-ChildItem -LiteralPath $payload -Force) {
    if (-not (Test-AppEntry $entry.Name)) { throw ('Unexpected archive entry: ' + $entry.Name) }
    $installed = Join-Path $target $entry.Name
    if ((Test-Path -LiteralPath $installed) -and
        ((Get-Item -LiteralPath $installed -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Installed application entries cannot be links.'
    }
  }
  if ($exeName -ne $canonicalExe) {
    Rename-Item -LiteralPath (Join-Path $payload $canonicalExe) -NewName $exeName
  }
  [IO.File]::WriteAllText((Join-Path $jobRoot 'payload.txt'), $payload, [Text.Encoding]::UTF8)
  exit 0
}

$payload = [IO.File]::ReadAllText((Join-Path $jobRoot 'payload.txt'), [Text.Encoding]::UTF8)
if ($payload -ne $stage -and -not $payload.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
$entries = @(Get-ChildItem -LiteralPath $payload -Force)
$backedUp = New-Object 'System.Collections.Generic.List[string]'
$written = New-Object 'System.Collections.Generic.List[string]'
$success = $false
$restored = $false
$message = ''
$logPath = Join-Path (Split-Path -Parent $config.resultPath) ('installer-' + $config.id + '.log')
function Write-UpdateLog([string]$event, [string]$detail = '') {
  $record = @{ time = [DateTime]::UtcNow.ToString('o'); event = $event; detail = $detail } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($logPath, $record + [Environment]::NewLine, [Text.Encoding]::UTF8)
}
try {
  Write-UpdateLog 'started'
  $parent = $null
  if ($config.parentPid -gt 0) {
    $parent = Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue
    if ($parent) { $null = $parent.Handle }
  }
  # A successful CreateProcess is not proof that PowerShell loaded the script.
  # The application must wait for this acknowledgement before exiting.
  [IO.File]::WriteAllText((Join-Path $jobRoot 'ready.json'), (@{ id = $config.id; pid = $PID } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  Write-UpdateLog 'waiting-for-application-exit'
  if ($parent -and -not $parent.WaitForExit(120000)) { throw 'Application did not exit; update cancelled.' }
  Write-UpdateLog 'installing'
  New-Item -ItemType Directory -Path $backup | Out-Null
  foreach ($entry in $entries) {
    $destination = Join-Path $target $entry.Name
    if (Test-Path -LiteralPath $destination) {
      for ($attempt = 0; ; $attempt++) {
        try { Move-Item -LiteralPath $destination -Destination (Join-Path $backup $entry.Name); break }
        catch { if ($attempt -ge 29) { throw }; Start-Sleep -Milliseconds 1000 }
      }
      $backedUp.Add($entry.Name)
    }
    $written.Add($entry.Name)
    Copy-Item -LiteralPath $entry.FullName -Destination $destination -Recurse -Force
  }
  $success = $true
  $message = 'Update installed.'
  Write-UpdateLog 'installed' $config.version
} catch {
  $message = $_.Exception.Message
  Write-UpdateLog 'failed' $message
  # Roll back only entries touched by this update.
  try {
    foreach ($name in $written) {
      $destination = Join-Path $target $name
      if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    }
    foreach ($name in $backedUp) {
      Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $target $name)
    }
    $restored = $true
  } catch { $message += '; rollback failed: ' + $_.Exception.Message + '; backup: ' + $backup }
} finally {
  @{ success = $success; restored = $restored; message = $message; version = $config.version } |
    ConvertTo-Json | Set-Content -LiteralPath $config.resultPath -Encoding UTF8
}
if ($success) { Remove-Item -LiteralPath $backup -Recurse -Force }
# Remove staging before the new version starts: first-run profile migration
# must not copy a job that this worker is deleting concurrently.
if ($success -or $restored) {
  try { Remove-Item -LiteralPath $jobRoot -Recurse -Force }
  catch { Write-UpdateLog 'cleanup-failed' $_.Exception.Message }
}
if (-not $NoRestart -and ($success -or $restored)) {
  Write-UpdateLog 'restarting'
  Start-Process -FilePath (Join-Path $target $exeName) -WorkingDirectory $target -WindowStyle Normal
  Write-UpdateLog 'restart-requested'
}
if (-not $success) { exit 1 }
`;

export interface PortableUpdateJob {
  directory: string;
  id: string;
  executable: string;
  resultPath: string;
  version: string;
  sha256: string;
  size: number;
}

// Start-Process creates the long-running worker independently of Node's child
// process job. Direct detached PowerShell may exit without running its script;
// a direct non-detached child can be terminated when Electron exits on Windows.
const PORTABLE_LAUNCH_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$arguments = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + (Join-Path $Directory 'updater.ps1') + '"'),
  '-ConfigPath', ('"' + (Join-Path $Directory 'job.json') + '"'),
  '-Mode', 'apply'
)
$worker = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $Directory) -WindowStyle Hidden -PassThru
@{ pid = $worker.Id } | ConvertTo-Json -Compress
`;

export async function preparePortableUpdate(
  job: PortableUpdateJob,
): Promise<void> {
  await writeFile(
    join(job.directory, 'updater.ps1'),
    PORTABLE_UPDATE_SCRIPT,
    'utf8',
  );
  await writeFile(
    join(job.directory, 'job.json'),
    JSON.stringify({
      id: job.id,
      target: dirname(job.executable),
      exeName: basename(job.executable),
      parentPid: process.pid,
      resultPath: job.resultPath,
      version: job.version,
      sha256: job.sha256,
      size: job.size,
    }),
    'utf8',
  );
  await execFileAsync(
    'powershell.exe',
    powershellArguments(job.directory, 'prepare'),
    {
      windowsHide: true,
      timeout: 180_000,
    },
  );
}

export async function launchPortableUpdate(directory: string): Promise<void> {
  const config = JSON.parse(
    await readFile(join(directory, 'job.json'), 'utf8'),
  );
  const readyPath = join(directory, 'ready.json');
  await rm(readyPath, { force: true });
  const launcherPath = join(directory, 'start-updater.ps1');
  await writeFile(launcherPath, PORTABLE_LAUNCH_SCRIPT, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcherPath,
        '-Directory',
        directory,
      ],
      { windowsHide: true, timeout: 15_000, cwd: dirname(directory) },
    );
    await writeFile(join(directory, 'launch.log'), stdout, 'utf8');
    const worker = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0)
      throw new Error('更新安装进程未返回有效进程编号。');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(
          (await readFile(readyPath, 'utf8')).replace(/^\uFEFF/, ''),
        );
        if (ready.id === config.id && ready.pid === worker.pid) return;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        )
          throw error;
      }
      await delay(50);
    }
    throw new Error('更新安装进程未就绪，程序未退出，请查看更新日志后重试。');
  } catch (error) {
    await writeFile(
      join(directory, 'launch-error.log'),
      error instanceof Error ? error.message : String(error),
      'utf8',
    ).catch(() => {});
    throw error;
  }
}

function powershellArguments(directory: string, mode: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(directory, 'updater.ps1'),
    '-ConfigPath',
    join(directory, 'job.json'),
    '-Mode',
    mode,
  ];
}
