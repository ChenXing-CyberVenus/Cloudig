param(
  [string]$Version = '1.0.0',
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$CandidateName
)
$ErrorActionPreference = 'Stop'
# Never build the application here. Only package the owner's already signed bytes.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid product version' }
$versionRoot = Join-Path $project "releases/$Version"
if ($CandidateName) { $versionRoot = Join-Path $versionRoot $CandidateName }
if ((Get-Item -LiteralPath $versionRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked release directory' }
$payload = Join-Path $versionRoot 'Cloudig'
if ((Get-Item -LiteralPath $payload).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked payload root' }
$before = Get-Content -LiteralPath (Join-Path $versionRoot 'SHA256-before-signing.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($before.product_version -ne $Version) { throw 'Wrong frozen version' }
$compiler = Join-Path $project 'manager/.cache/inno-setup-7.1.0/compiler/ISCC.exe'
if ((Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid') { throw 'Compiler signature is not valid' }
$compilerSha256 = 'd06ebd38f38e3cee60a3c50cc45bd449d77e0bc6a5cabc607ea9886808e4de1a'
if ((Get-FileHash -LiteralPath $compiler).Hash.ToLowerInvariant() -ne $compilerSha256) { throw 'Unexpected compiler bytes' }
$output = Join-Path $versionRoot "Cloudig-$Version-Setup.exe"
if (Test-Path -LiteralPath $output) { throw 'Installer already exists. Never overwrite a signing handoff.' }
foreach ($receipt in @('SHA256-signed-payload.json','installer-before-signing.json')) {
  if (Test-Path -LiteralPath (Join-Path $versionRoot $receipt)) { throw "Existing receipt is immutable: $receipt" }
}
$work = Join-Path $versionRoot 'installer-build'
New-Item -ItemType Directory -Force -Path $work | Out-Null
function Sha([string]$Name) { (Get-FileHash -LiteralPath $Name -Algorithm SHA256).Hash.ToLowerInvariant() }
$backup = Join-Path $versionRoot $before.unsigned_backup.path
if ((Sha $backup) -ne $before.unsigned_backup.sha256) { throw 'Unsigned backup changed' }
$owned = @($before.signing_targets.path)
$allFiles = @(Get-ChildItem -LiteralPath $payload -Recurse -Force)
if (@($allFiles | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked payload' }
if (@($allFiles | Where-Object { -not $_.PSIsContainer }).Count -ne $before.file_count) { throw 'Payload file count changed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($backup)
$files = @(); $signatures = @(); $signer = $null
try {
  foreach ($old in $before.files) {
    if ($old.path -match '(^|/)\.\.?(/|$)|[":]' -or $old.path.StartsWith('/')) { throw 'Unsafe frozen path' }
    $name = Join-Path $payload $old.path
    $actual = Sha $name
    if ($old.path -notin $owned) {
      if ($actual -ne $old.sha256) { throw "Non-signing file changed: $($old.path)" }
    } else {
      $sig = Get-AuthenticodeSignature -LiteralPath $name
      if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate) { throw "Invalid or untimestamped signature: $($old.path)" }
      if ($signer -and $signer -ne $sig.SignerCertificate.Thumbprint) { throw 'Mixed owner signing certificates' }
      $signer = $sig.SignerCertificate.Thumbprint
      if ((Get-Item -LiteralPath $name).VersionInfo.ProductVersion -ne ($Version + '+' + $before.source_build.commit)) { throw 'Signed version changed' }
      # Authenticode may change only the checksum, security directory and appended certificate.
      $entry = @($zip.Entries | Where-Object { $_.FullName.Replace('\','/') -eq ('Cloudig/' + $old.path) }) | Select-Object -First 1
      if (-not $entry) { throw "Unsigned backup entry missing: $($old.path)" }
      $stream = $entry.Open(); $memory = [IO.MemoryStream]::new()
      try { $stream.CopyTo($memory); [byte[]]$original = $memory.ToArray() }
      finally { $stream.Dispose(); $memory.Dispose() }
      [byte[]]$signed = [IO.File]::ReadAllBytes($name)
      $pe = [BitConverter]::ToInt32($original, 0x3c)
      $optional = $pe + 24
      $magic = [BitConverter]::ToUInt16($original, $optional)
      $directory = $optional + $(if ($magic -eq 0x20b) { 112 } elseif ($magic -eq 0x10b) { 96 } else { throw 'Unknown PE format' }) + 32
      $certificateOffset = [BitConverter]::ToUInt32($signed, $directory)
      $certificateLength = [BitConverter]::ToUInt32($signed, $directory + 4)
      if ($certificateOffset -lt $original.Length -or $certificateOffset -gt $original.Length + 7 -or $certificateOffset + $certificateLength -ne $signed.Length) { throw 'Unexpected signed PE layout' }
      [Array]::Copy($original, $optional + 64, $signed, $optional + 64, 4)
      [Array]::Copy($original, $directory, $signed, $directory, 8)
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $normalized = [BitConverter]::ToString($hash.ComputeHash($signed,0,$original.Length)).Replace('-','').ToLowerInvariant() }
      finally { $hash.Dispose() }
      if ($normalized -ne $old.sha256) { throw "Signature also changed program bytes: $($old.path)" }
      $signatures += [ordered]@{path=$old.path;status=[string]$sig.Status;signer=$sig.SignerCertificate.Subject;thumbprint=$signer;timestamp=$sig.TimeStamperCertificate.Subject;original_code_unchanged=$true}
    }
    $files += [ordered]@{path=$old.path;bytes=(Get-Item -LiteralPath $name).Length;sha256=$actual}
  }
} finally { $zip.Dispose() }
$utf8 = [Text.UTF8Encoding]::new($false)
$manifest = [ordered]@{product_version=$Version;source_build=$before.source_build;verified_at=[DateTime]::UtcNow.ToString('o');file_count=$files.Count;signatures=$signatures;files=$files}
[IO.File]::WriteAllText((Join-Path $versionRoot 'SHA256-signed-payload.json'),($manifest | ConvertTo-Json -Depth 10) + "`n",$utf8)
$entries = @(); $checks = @('function CheckPayloadFiles: String;', 'begin', "  Result := '';" )
foreach ($file in $files) {
  $relative = $file.path.Replace('/','\')
  $dest = [IO.Path]::GetDirectoryName($relative)
  $entries += ('Source: "' + (Join-Path $payload $relative) + '"; DestDir: "{app}' + $(if ($dest) {'\' + $dest} else {''}) + '"; Flags: ignoreversion')
  $checks += ("  Result := CheckFile('" + $relative.Replace("'","''") + "'); if Result <> '' then Exit;")
}
$checks += 'end;'
$fileInclude = Join-Path $work 'payload-files.iss'
$checkInclude = Join-Path $work 'payload-checks.iss'
[IO.File]::WriteAllText($fileInclude,($entries -join "`n") + "`n",$utf8)
[IO.File]::WriteAllText($checkInclude,($checks -join "`n") + "`n",$utf8)
$v = [Version]$Version
$args = @('--quiet-progress','--no-ide-signtools',"--output-dir=$versionRoot", "--define=ProductVersion=$Version", "--define=ProjectRoot=$project", "--define=PayloadRoot=$payload", "--define=PayloadFiles=$fileInclude", "--define=PayloadChecks=$checkInclude", "--define=VersionMS=$($v.Major * 65536 + $v.Minor)", "--define=VersionLS=$($v.Build * 65536)", (Join-Path $project 'release/windows/Cloudig.iss'))
& $compiler @args
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" }
foreach ($file in $files) { if ((Sha (Join-Path $payload $file.path)) -ne $file.sha256) { throw 'Signed input changed during compilation' } }
if ((Get-AuthenticodeSignature -LiteralPath $output).Status -ne 'NotSigned') { throw 'Unexpected outer signing state' }
Copy-Item -LiteralPath $output -Destination (Join-Path $work "Cloudig-$Version-Setup-unsigned.exe")
$result = [ordered]@{status='awaiting-installer-tests-and-owner-signature';product_version=$Version;installer=[ordered]@{path=$output;bytes=(Get-Item -LiteralPath $output).Length;sha256=(Sha $output);signature=[string](Get-AuthenticodeSignature -LiteralPath $output).Status};compiler=[ordered]@{version='7.1.0';sha256=(Sha $compiler)};template_sha256=(Sha (Join-Path $project 'release/windows/Cloudig.iss'));payload_manifest_sha256=(Sha (Join-Path $versionRoot 'SHA256-signed-payload.json'));payload_files=$files.Count}
[IO.File]::WriteAllText((Join-Path $versionRoot 'installer-before-signing.json'),($result | ConvertTo-Json -Depth 8) + "`n",$utf8)
$result | ConvertTo-Json -Depth 8
