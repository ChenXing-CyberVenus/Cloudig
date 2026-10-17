param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Case,
  [string]$InitialDirectory = "$env:USERPROFILE\Cloudig",
  [ValidateSet('en','zh')][string]$Language = 'en',
  [switch]$SelectionTests,
  [switch]$InstallCheck
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Case -notmatch '^[a-z0-9-]+$') { throw 'Invalid case name' }
$root = Join-Path $project "tests/private/windows-installer-picker-20260922/$Case"
if (Test-Path -LiteralPath $root) { throw 'Never overwrite an existing probe' }
if ($InstallCheck -and -not $SelectionTests) { throw 'Installation must follow folder selection tests' }
Add-Type -Path (Join-Path $PSScriptRoot 'installer-picker-probe.cs')
[InstallerPickerProbe]::Run([IO.Path]::GetFullPath($Installer),$root,$InitialDirectory,$Language,[bool]$SelectionTests)
if ($InstallCheck) {
  $destination = Join-Path $root '中文 空格/Cloudig'
  if (Test-Path -LiteralPath $destination) { throw 'Fresh test destination must not exist' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = [IO.Path]::GetFullPath($Installer)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $start.Environment['TEMP'] = Join-Path $root 'temp'
  $start.Environment['TMP'] = Join-Path $root 'temp'
  foreach ($arg in @('/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART',"/LANG=$Language",'/TASKS=',"/DIR=$destination","/LOG=$root/install.log")) { $start.ArgumentList.Add($arg) }
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process.WaitForExit(180000)) { throw "Owned installer did not finish: PID=$($process.Id)" }
  if ($process.ExitCode -ne 0) { throw "Install failed: $($process.ExitCode)" }
  $manifest = Get-Content -LiteralPath (Join-Path $project 'releases/1.0.0/SHA256-signed-payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($file in $manifest.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $destination $file.path)).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Installed bytes differ: $($file.path)" }
  }
  foreach ($file in $manifest.signatures) {
    if ((Get-AuthenticodeSignature -LiteralPath (Join-Path $destination $file.path)).Status -ne 'Valid') { throw "Installed signature invalid: $($file.path)" }
  }
  if (@(Get-ChildItem -LiteralPath $destination -Filter 'unins*' -File).Count) { throw 'Unexpected uninstaller' }
  $receipt = [ordered]@{ status='passed'; destination=$destination; program_files=$manifest.file_count; installed_payload_unchanged=$true; owned_signatures_valid=$manifest.signatures.Count; temporary_files=@(Get-ChildItem -LiteralPath (Join-Path $root 'temp') -Recurse -File).Count; physical_pointer=$false; interactive_selection=$true; installation='silent at the destination returned by the tested picker' }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'install-result.json') -Encoding utf8
  $receipt | ConvertTo-Json
}
