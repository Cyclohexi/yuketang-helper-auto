param(
  [switch]$CheckOnly,
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectDirectory = Split-Path -Parent $PSScriptRoot
$desktopDirectory = Join-Path $projectDirectory 'apps\desktop'
$electronPath = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'

function Test-SourceBuildRequired {
  $outputPaths = @('dist\main\index.cjs', 'dist\preload\index.cjs', 'dist\renderer\index.html')
  $outputs = @()
  foreach ($relativePath in $outputPaths) {
    $outputPath = Join-Path $desktopDirectory $relativePath
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { return $true }
    $outputs += Get-Item -LiteralPath $outputPath
  }
  $oldestOutput = ($outputs | Sort-Object LastWriteTimeUtc | Select-Object -First 1).LastWriteTimeUtc
  $sourceRoots = @(
    (Join-Path $desktopDirectory 'main'),
    (Join-Path $desktopDirectory 'preload'),
    (Join-Path $desktopDirectory 'renderer')
  )
  $packageDirectories = @(Get-ChildItem -LiteralPath (Join-Path $projectDirectory 'packages') -Directory -ErrorAction SilentlyContinue)
  foreach ($packageDirectory in $packageDirectories) { $sourceRoots += Join-Path $packageDirectory.FullName 'src' }
  foreach ($sourceRoot in $sourceRoots) {
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { continue }
    # Directory timestamps also detect deleted/renamed source files.
    $entries = @((Get-Item -LiteralPath $sourceRoot)) + @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force)
    foreach ($entry in $entries) {
      if (($entry.PSIsContainer -or $entry.Extension -in @('.ts', '.vue', '.css', '.html', '.mjs', '.json')) -and
          $entry.LastWriteTimeUtc -gt $oldestOutput) { return $true }
    }
  }
  $configDirectories = @($projectDirectory, $desktopDirectory) + @($packageDirectories | ForEach-Object { $_.FullName })
  foreach ($directory in $configDirectories) {
    foreach ($config in Get-ChildItem -LiteralPath $directory -File) {
      if ($config.Extension -in @('.json', '.ts') -and $config.LastWriteTimeUtc -gt $oldestOutput) { return $true }
    }
  }
  return $false
}

try {
  $plan = $null
  # The source launcher always prefers the source build over an older ZIP build.
  if (Test-Path -LiteralPath $electronPath -PathType Leaf) {
    $plan = [pscustomobject]@{
      mode = 'source'
      executable = $electronPath
      workingDirectory = $desktopDirectory
      buildRequired = [bool]($Rebuild -or (Test-SourceBuildRequired))
    }
  } elseif (-not $Rebuild) {
    $outputDirectory = Join-Path $projectDirectory 'desktop\out'
    if (Test-Path -LiteralPath $outputDirectory -PathType Container) {
      $portableDirectories = @(Get-ChildItem -LiteralPath $outputDirectory -Directory -Filter '*-win32-x64' | Sort-Object LastWriteTimeUtc -Descending)
      foreach ($directory in $portableDirectories) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory.FullName 'portable.flag') -PathType Leaf)) { continue }
        foreach ($name in @('YuketangHelper.exe', '雨课堂助手.exe')) {
          $executable = Join-Path $directory.FullName $name
          if (Test-Path -LiteralPath $executable -PathType Leaf) {
            $plan = [pscustomobject]@{ mode = 'portable'; executable = $executable; workingDirectory = $directory.FullName; buildRequired = $false }
            break
          }
        }
        if ($null -ne $plan) { break }
      }
    }
  }
  if ($null -eq $plan) {
    throw "未找到本地运行依赖。请先在 $projectDirectory 执行 npm ci --include=dev --include=optional，再双击启动。"
  }
  if ($CheckOnly) {
    $plan | ConvertTo-Json -Compress
    exit 0
  }
  Write-Host '雨课堂助手启动器' -ForegroundColor Green
  if ($plan.buildRequired) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { throw '构建源码需要 Node.js 24 和 npm 11，请先配置开发环境。' }
    Write-Host '检测到源码更新或缺少构建文件，正在构建，请稍候…'
    Push-Location -LiteralPath $projectDirectory
    try {
      & $npm.Source run build
      if ($LASTEXITCODE -ne 0) { throw '构建失败，以上错误需要先修复。' }
    } finally { Pop-Location }
  }
  if ($plan.mode -eq 'source') { Write-Host '正在启动源码版本…' }
  else { Write-Host '正在启动本地便携版…' }
  # Windows paths stay in structured arguments, including spaces, Chinese,
  # parentheses, ampersands, and exclamation marks.
  $startOptions = @{ FilePath = $plan.executable; WorkingDirectory = $plan.workingDirectory; WindowStyle = 'Normal'; PassThru = $true }
  if ($plan.mode -eq 'source') { $startOptions.ArgumentList = '.' }
  $process = Start-Process @startOptions
  if ($process.WaitForExit(1000) -and $process.ExitCode -ne 0) {
    throw "程序启动失败，退出码：$($process.ExitCode)。"
  }
  Write-Host '启动请求已发出。'
  exit 0
} catch {
  [Console]::Error.WriteLine('启动失败：' + $_.Exception.Message)
  exit 1
}
