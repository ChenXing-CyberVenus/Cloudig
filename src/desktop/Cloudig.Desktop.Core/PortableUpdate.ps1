param([string]$RequestFile, [string]$ExpectedHash, [int]$OwnerExitSeconds)
$ErrorActionPreference = 'Stop'
function AssertPlain([string]$name) {
  $cursor = [IO.Path]::GetFullPath($name)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked update path.' }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function ShowFailure([string]$message) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($message, 'Cloudig') | Out-Null }
$request = $null
$lease = $null
try {
  AssertPlain $RequestFile
  $lease = [IO.File]::Open($RequestFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ((Get-FileHash -LiteralPath $RequestFile -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Update request changed.' }
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.Schema -ne 'cloudig/portable-update/1.0.0') { throw 'Unknown update request.' }
  $folder = [IO.Path]::GetFullPath((Join-Path $request.LibraryRoot 'cache\Update'))
  if ([IO.Path]::GetFullPath($RequestFile) -ne (Join-Path $folder 'request.json') -or [IO.Path]::GetFullPath($request.Installer) -ne (Join-Path $folder 'Cloudig-Update.exe')) { throw 'Update paths do not match this Library.' }
  AssertPlain $request.ProgramRoot
  AssertPlain $request.Installer
  if ((Get-Item -LiteralPath $request.Installer).Length -ne $request.Bytes -or (Get-FileHash -LiteralPath $request.Installer -Algorithm SHA256).Hash -ne $request.Sha256) { throw 'Update bytes changed.' }
  $signature = Get-AuthenticodeSignature -LiteralPath $request.Installer
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate -or $signature.SignerCertificate.Thumbprint -ne $request.PublisherThumbprint) { throw 'Update signature verification failed.' }
  $owner = Get-Process -Id $request.OwnerPid -ErrorAction SilentlyContinue
  if ($owner -and $owner.StartTime.ToUniversalTime().Ticks.ToString() -eq $request.OwnerStarted) {
    if (-not $owner.WaitForExit($OwnerExitSeconds * 1000)) { throw 'Cloudig is still closing; the update was not applied.' }
  }
  # The signed installer already has exact payload paths, locked-file checks,
  # downgrade prevention and user-data preservation. Never invent a root copy.
  $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /TASKS= /DIR="' + $request.ProgramRoot + '" /LOG="' + (Join-Path $folder 'install.log') + '"'
  $installed = Start-Process -FilePath $request.Installer -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
  if ($installed.ExitCode -ne 0) { throw ('Installer exit code: ' + $installed.ExitCode) }
  $exe = Join-Path $request.ProgramRoot 'Cloudig.exe'
  $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion.Split('+')[0]
  if ($version -ne $request.Version) { throw 'Installed version does not match the requested update.' }
  $relaunch = New-Object Diagnostics.ProcessStartInfo
  $relaunch.FileName = $exe; $relaunch.UseShellExecute = $false; $relaunch.WorkingDirectory = $request.ProgramRoot
  if ($request.ProgramRoot -ne $request.LibraryRoot) { $relaunch.Arguments = '--data-root "' + $request.LibraryRoot + '"' }
  [Diagnostics.Process]::Start($relaunch) | Out-Null
  $lease.Dispose(); $lease = $null
  # Delete only this helper's exact completed temporary files, never the root.
  foreach ($file in @($request.Installer, $RequestFile, (Join-Path $folder 'install.log'))) { if (Test-Path -LiteralPath $file) { AssertPlain $file; Remove-Item -LiteralPath $file -Force } }
  if (-not (Get-ChildItem -LiteralPath $folder -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $folder }
} catch {
  $extra = if ($request) { "`n" + $request.Installer } else { '' }
  ShowFailure ("采云更新未完成，资料库没有被清理。已下载的安装器保留，可关闭采云后重新运行它完成更新。`nCloudig update did not complete. Your Library was not removed. The downloaded installer is preserved for retry.`n" + $_.Exception.Message + $extra)
  exit 1
} finally { if ($lease) { $lease.Dispose() } }
