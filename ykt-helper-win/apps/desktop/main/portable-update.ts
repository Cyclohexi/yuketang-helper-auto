import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

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
try {
  if ($config.parentPid -gt 0) {
    $parent = Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue
    if ($parent -and -not $parent.WaitForExit(120000)) { throw 'Application did not exit; update cancelled.' }
  }
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
} catch {
  $message = $_.Exception.Message
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
if (-not $NoRestart -and ($success -or $restored)) {
  Start-Process -FilePath (Join-Path $target $exeName) -WorkingDirectory $target -WindowStyle Hidden
}
# jobRoot is the dedicated update job directory; never the installation root.
if ($success -or $restored) { Remove-Item -LiteralPath $jobRoot -Recurse -Force }
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
  const child = spawn(
    'powershell.exe',
    powershellArguments(directory, 'apply'),
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
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
