param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][string]$Log,
  [string]$LockPath,
  [ValidateSet('original','r1','r2')][string]$InstallerRevision = 'original',
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')][string]$Version = '1.0.0',
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$CandidateName
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$suffix = if ($InstallerRevision -ne 'original') { "-$InstallerRevision" } else { '' }
$release = if ($InstallerRevision -ne 'original') { "releases/$Version/installer-$InstallerRevision" } else { "releases/$Version" }
if ($CandidateName -and $InstallerRevision -ne 'original') { throw 'CandidateName and historical InstallerRevision cannot be combined' }
if ($CandidateName) { $release += "/$CandidateName" }
$evidence = Join-Path $project "$release/installer-test"
$scope = Join-Path $project "tests/private/windows-installer-$Version$suffix"
if ($CandidateName) { $scope += "-$CandidateName" }
$dest = [IO.Path]::GetFullPath($Destination)
if (-not $dest.StartsWith($scope + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test destination outside owned test root' }
if (-not [IO.Path]::GetFullPath($Log).StartsWith($evidence + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test log outside evidence root' }
$temp = Join-Path $scope 'setup-temp'
New-Item -ItemType Directory -Force -Path $temp,$evidence | Out-Null
$registryPaths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cloudig.Portable.Windows_is1',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cloudig.Portable.Windows_is1',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Cloudig.Portable.Windows_is1'
)
foreach ($p in $registryPaths) { if (Test-Path -LiteralPath $p) { throw 'Unexpected pre-existing Cloudig uninstall key' } }
$lock = $null
try {
  if ($LockPath) {
    if (-not [IO.Path]::GetFullPath($LockPath).StartsWith($scope + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Lock outside owned test root' }
    $lock = [IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Installer; $start.UseShellExecute = $false
  $start.CreateNoWindow = $true; $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $start.Environment['TEMP'] = $temp; $start.Environment['TMP'] = $temp
  $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/LANG=en','/TASKS=',"/DIR=$dest","/LOG=$Log")
  if ($null -ne $start.ArgumentList) { foreach ($arg in $arguments) { $start.ArgumentList.Add($arg) } }
  else { $start.Arguments = ($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' ' }
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process.WaitForExit(180000)) { throw "Owned installer did not finish: PID=$($process.Id)" }
  $code = $process.ExitCode
} finally { if ($lock) { $lock.Dispose() } }
foreach ($p in $registryPaths) { if (Test-Path -LiteralPath $p) { throw 'Installer wrote an uninstall key' } }
if ((Test-Path -LiteralPath $dest) -and @(Get-ChildItem -LiteralPath $dest -Filter 'unins*' -File).Count) { throw 'Installer wrote an uninstaller' }
$signatures = @()
if ($code -eq 0) {
  foreach ($name in @('Cloudig.exe','app/Cloudig.dll','app/Cloudig.Desktop.Core.dll','app/Cloudig.Bookmarks.dll')) {
    $sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $dest $name)
    if ($sig.Status -ne 'Valid') { throw "Installed signature invalid: $name" }
    $signatures += [ordered]@{path=$name;status=[string]$sig.Status;thumbprint=$sig.SignerCertificate.Thumbprint}
  }
}
[ordered]@{exit_code=$code;destination=$dest;log=$Log;signatures=$signatures;uninstall_registry_absent=$true;uninstaller_absent=$true;temporary_files=@(Get-ChildItem -LiteralPath $temp -Recurse -File).Count} | ConvertTo-Json -Depth 6
