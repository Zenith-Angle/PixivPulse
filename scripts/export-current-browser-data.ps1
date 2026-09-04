param(
  [string]$ChromeProfile,
  [string]$ExtensionId = 'plmpmbeabfblkedifgadkeanbdbfbdlf',
  [string]$DestinationRoot,
  [int]$MaxAttempts = 5
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ChromeProfile)) {
  $ChromeProfile = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default'
}

if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  $DestinationRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'
}

$sources = @(
  [pscustomobject]@{
    Name = 'indexeddb-leveldb'
    Path = Join-Path $ChromeProfile "IndexedDB\chrome-extension_${ExtensionId}_0.indexeddb.leveldb"
  },
  [pscustomobject]@{
    Name = 'indexeddb-blob'
    Path = Join-Path $ChromeProfile "IndexedDB\chrome-extension_${ExtensionId}_0.indexeddb.blob"
  },
  [pscustomobject]@{
    Name = 'local-extension-settings'
    Path = Join-Path $ChromeProfile "Local Extension Settings\$ExtensionId"
  }
)

foreach ($source in $sources) {
  if (-not (Test-Path -LiteralPath $source.Path -PathType Container)) {
    throw "Source directory does not exist: $($source.Path)"
  }
}

[IO.Directory]::CreateDirectory($DestinationRoot) | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$finalPath = Join-Path $DestinationRoot "${stamp}-before-data-restructure"
$fileShare = [IO.FileShare]([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)

function Get-SharedSha256([string]$Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    $script:fileShare
  )

  try {
    return [Convert]::ToHexString(
      [Security.Cryptography.SHA256]::HashData($stream)
    ).ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
  }
}

function Get-SourceSnapshot {
  $items = @()

  foreach ($source in $script:sources) {
    $files = @(
      Get-ChildItem -LiteralPath $source.Path -File -Recurse -Force |
        Where-Object { $_.Name -ne 'LOCK' } |
        Sort-Object FullName
    )

    foreach ($file in $files) {
      $relativePath = [IO.Path]::GetRelativePath($source.Path, $file.FullName).Replace('\', '/')
      $items += [pscustomobject]@{
        LogicalPath = "$($source.Name)/$relativePath"
        PhysicalPath = $file.FullName
        Length = $file.Length
        Hash = Get-SharedSha256 $file.FullName
      }
    }
  }

  return @($items | Sort-Object LogicalPath)
}

function Get-DestinationSnapshot([string]$Root) {
  $items = @()

  foreach ($source in $script:sources) {
    $componentPath = Join-Path $Root $source.Name
    $files = @(Get-ChildItem -LiteralPath $componentPath -File -Recurse -Force | Sort-Object FullName)

    foreach ($file in $files) {
      $relativePath = [IO.Path]::GetRelativePath($componentPath, $file.FullName).Replace('\', '/')
      $items += [pscustomobject]@{
        LogicalPath = "$($source.Name)/$relativePath"
        PhysicalPath = $file.FullName
        Length = $file.Length
        Hash = Get-SharedSha256 $file.FullName
      }
    }
  }

  return @($items | Sort-Object LogicalPath)
}

function Get-Signature($Items) {
  return (($Items | ForEach-Object {
    "$($_.LogicalPath)|$($_.Length)|$($_.Hash)"
  }) -join [char]10)
}

function Get-AggregateSha256($Items) {
  $bytes = [Text.Encoding]::UTF8.GetBytes((Get-Signature $Items))
  return [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($bytes)
  ).ToLowerInvariant()
}

function Copy-SharedFile([string]$Source, [string]$Destination) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
  $inputStream = [IO.File]::Open(
    $Source,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    $script:fileShare
  )

  try {
    $outputStream = [IO.File]::Open(
      $Destination,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )

    try {
      $inputStream.CopyTo($outputStream, 1MB)
      $outputStream.Flush($true)
    }
    finally {
      $outputStream.Dispose()
    }
  }
  finally {
    $inputStream.Dispose()
  }
}

function Remove-OwnStagingDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedRoot = [IO.Path]::GetFullPath($script:DestinationRoot) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove staging directory outside destination root: $resolvedPath"
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

$result = $null
$lastFailure = $null

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  $stagingPath = "${finalPath}.building-$attempt"
  if (Test-Path -LiteralPath $stagingPath) {
    throw "Staging directory already exists: $stagingPath"
  }

  try {
    $before = Get-SourceSnapshot
    [IO.Directory]::CreateDirectory($stagingPath) | Out-Null

    foreach ($item in $before) {
      Copy-SharedFile $item.PhysicalPath (Join-Path $stagingPath $item.LogicalPath)
    }

    $after = Get-SourceSnapshot
    $destination = Get-DestinationSnapshot $stagingPath

    if (
      (Get-Signature $before) -eq (Get-Signature $after) -and
      (Get-Signature $before) -eq (Get-Signature $destination)
    ) {
      Move-Item -LiteralPath $stagingPath -Destination $finalPath

      $components = foreach ($source in $sources) {
        $componentFiles = @($destination | Where-Object {
          $_.LogicalPath.StartsWith("$($source.Name)/")
        })
        [pscustomobject]@{
          Name = $source.Name
          Files = $componentFiles.Count
          Bytes = ($componentFiles | Measure-Object Length -Sum).Sum
        }
      }

      $result = [pscustomobject]@{
        BackupPath = $finalPath
        Attempt = $attempt
        Files = $destination.Count
        Bytes = ($destination | Measure-Object Length -Sum).Sum
        AggregateSha256 = Get-AggregateSha256 $destination
        Components = @($components)
      }
      break
    }

    $lastFailure = 'Source data changed during the copy window.'
  }
  catch {
    $lastFailure = $_.Exception.Message
  }

  Remove-OwnStagingDirectory $stagingPath
  if ($attempt -lt $MaxAttempts) {
    Start-Sleep -Milliseconds 750
  }
}

if ($null -eq $result) {
  throw "Could not create a stable backup after $MaxAttempts attempts. Last failure: $lastFailure"
}

$result | ConvertTo-Json -Depth 5
