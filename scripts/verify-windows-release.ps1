param(
  [ValidateSet('original','r1','r2')][string]$InstallerRevision = 'original',
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')][string]$Version = '1.0.0',
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$CandidateName
)
$ErrorActionPreference = 'Stop'
# Verify frozen version bytes; the old 1.0.0 r1/r2 receipts remain readable.
# Never compile, sign, modify payload, overwrite receipts, or publish.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Version -ne '1.0.0' -and $InstallerRevision -ne 'original') { throw 'r1/r2 belong only to the historical 1.0.0 release' }
$releaseRoot = Join-Path $project "releases/$Version"
if ($CandidateName -and $InstallerRevision -ne 'original') { throw 'CandidateName and historical InstallerRevision cannot be combined' }
if ($CandidateName) { $releaseRoot = Join-Path $releaseRoot $CandidateName }
$suffix = if ($InstallerRevision -ne 'original') { "-$InstallerRevision" } else { '' }
$release = if ($InstallerRevision -ne 'original') { Join-Path $releaseRoot "installer-$InstallerRevision" } else { $releaseRoot }
$before = Get-Content -LiteralPath (Join-Path $release 'installer-before-signing.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$payloadManifest = Join-Path $(if ($InstallerRevision -eq 'r2') { $release } else { $releaseRoot }) 'SHA256-signed-payload.json'
$payload = Get-Content -LiteralPath $payloadManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($before.product_version -ne $Version -or $payload.product_version -ne $Version) { throw 'Frozen payload/installer version mismatch' }
$installerName = "Cloudig-$Version-Setup$suffix.exe"
$installer = Join-Path $release $installerName
$backup = Join-Path $release "installer-build/Cloudig-$Version-Setup$suffix-unsigned.exe"
$manifestName = "Cloudig-$Version$suffix-release-manifest.json"
$checksumsName = "SHA256SUMS$suffix.txt"
foreach ($name in @('installer-test/signed-final.log','installer-test/signed-final.json',$manifestName,$checksumsName)) {
  if (Test-Path -LiteralPath (Join-Path $release $name)) { throw "Existing receipt is immutable: $name" }
}
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
if ((Sha $backup) -ne $before.installer.sha256) { throw 'Unsigned installer backup changed' }
if ((Sha $payloadManifest) -ne $before.payload_manifest_sha256) { throw 'Signed payload manifest changed' }
$sig = Get-AuthenticodeSignature -LiteralPath $installer
if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate) { throw 'Outer signature or timestamp missing/invalid' }
if (@($payload.signatures | Where-Object { $_.thumbprint -ne $sig.SignerCertificate.Thumbprint }).Count) { throw 'Outer signer differs from the verified inner signer' }
if ((Get-Item -LiteralPath $installer).VersionInfo.FileVersion.Trim() -ne "$Version.0") { throw 'Installer version changed' }

# Normalize only PE checksum/security-directory bytes, then hash the complete
# original-length EXE including Inno's embedded payload. Bounded 1 MiB buffer.
$original = [IO.File]::OpenRead($backup); $signed = [IO.File]::OpenRead($installer)
$hash = [Security.Cryptography.SHA256]::Create()
try {
  $headBefore = [byte[]]::new(4096); $headAfter = [byte[]]::new(4096)
  if ($original.Read($headBefore,0,4096) -ne 4096 -or $signed.Read($headAfter,0,4096) -ne 4096) { throw 'Truncated executable header' }
  $optional = [BitConverter]::ToInt32($headBefore,0x3c) + 24
  $magic = [BitConverter]::ToUInt16($headBefore,$optional)
  $directory = $optional + $(if ($magic -eq 0x20b) {112} elseif ($magic -eq 0x10b) {96} else {throw 'Unknown PE header'}) + 32
  if ($directory + 8 -gt 4096) { throw 'Unexpected PE header size' }
  if ([BitConverter]::ToUInt64($headBefore,$directory) -ne 0) { throw 'Backup was not unsigned' }
  $certificateOffset = [BitConverter]::ToUInt32($headAfter,$directory)
  $certificateLength = [BitConverter]::ToUInt32($headAfter,$directory + 4)
  if ($certificateOffset -lt $original.Length -or $certificateOffset -gt $original.Length + 7 -or $certificateOffset + $certificateLength -ne $signed.Length) { throw 'Unexpected appended certificate layout' }
  [Array]::Copy($headBefore,$optional + 64,$headAfter,$optional + 64,4)
  [Array]::Copy($headBefore,$directory,$headAfter,$directory,8)
  $hash.TransformBlock($headAfter,0,4096,$headAfter,0) | Out-Null
  $remaining = $original.Length - 4096; $buffer = [byte[]]::new(1048576)
  while ($remaining -gt 0) {
    $n = $signed.Read($buffer,0,[int][Math]::Min($remaining,$buffer.Length))
    if ($n -eq 0) { throw 'Truncated signed installer' }
    $hash.TransformBlock($buffer,0,$n,$buffer,0) | Out-Null
    $remaining -= $n
  }
  $hash.TransformFinalBlock([byte[]]::new(0),0,0) | Out-Null
  $normalized = [BitConverter]::ToString($hash.Hash).Replace('-','').ToLowerInvariant()
  if ($normalized -ne $before.installer.sha256) { throw 'Signing also changed installer content' }
  while ($signed.Position -lt $certificateOffset) { if ($signed.ReadByte() -ne 0) { throw 'Nonzero signature alignment padding' } }
} finally { $original.Dispose(); $signed.Dispose(); $hash.Dispose() }
$finalSha = Sha $installer
$scope = Join-Path $project "tests/private/windows-installer-$Version$suffix"
if ($CandidateName) { $scope += "-$CandidateName" }
if (Test-Path -LiteralPath $scope) { throw 'Do not reuse an existing test directory' }
New-Item -ItemType Directory -Path $scope | Out-Null
$destination = Join-Path $scope 'signed-final'
$log = Join-Path $release 'installer-test/signed-final.log'
$candidateArgs = @{}
if ($CandidateName) { $candidateArgs.CandidateName = $CandidateName }
$result = & (Join-Path $PSScriptRoot 'test-windows-installer-native.ps1') -Installer $installer -Destination $destination -Log $log -InstallerRevision $InstallerRevision -Version $Version @candidateArgs | ConvertFrom-Json
if ($result.exit_code -ne 0 -or $result.temporary_files -ne 0) { throw 'Signed installer failed or left temporary files' }
$verificationRoots = if ($InstallerRevision -eq 'r2') { @($destination) } else { @($destination,(Join-Path $releaseRoot 'Cloudig')) }
foreach ($root in $verificationRoots) {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -Force)
  if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked verification root' }
  if (@($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked verification input' }
  if (@($files | Where-Object { -not $_.PSIsContainer }).Count -ne $payload.file_count) { throw 'Unexpected payload files' }
  foreach ($file in $payload.files) {
    if ((Sha (Join-Path $root $file.path)) -ne $file.sha256) { throw "Payload changed: $root/$($file.path)" }
  }
}
if ($InstallerRevision -eq 'r2') {
  $baseManifestPath = Join-Path $releaseRoot 'SHA256-signed-payload.json'
  if ((Sha $baseManifestPath) -ne $payload.base_payload_manifest_sha256) { throw 'Original signed manifest changed' }
  $original = Get-Content -LiteralPath $baseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($file in $original.files) {
    if ((Sha (Join-Path (Join-Path $releaseRoot 'Cloudig') $file.path)) -ne $file.sha256) { throw 'Original signed release was modified' }
  }
}
foreach ($item in $result.signatures) { if ($item.thumbprint -ne $sig.SignerCertificate.Thumbprint) { throw 'Installed signer mismatch' } }
if ((Sha $installer) -ne $finalSha) { throw 'Installer changed during validation' }
$utf8 = [Text.UTF8Encoding]::new($false)
$receipt = [ordered]@{status='passed';verified_at=[DateTime]::UtcNow.ToString('o');outer_signature=[string]$sig.Status;timestamp=$sig.TimeStamperCertificate.Subject;normalized_unsigned_sha256=$normalized;unsigned_content_unchanged=$true;installer_sha256=$finalSha;installed_files=$payload.file_count;installation=$result}
[IO.File]::WriteAllText((Join-Path $release 'installer-test/signed-final.json'),($receipt | ConvertTo-Json -Depth 8) + "`n",$utf8)
$public = [ordered]@{product='Cloudig';version=$Version;codename='DawnGlow';platform='windows-x64';source_build=$payload.source_build.commit;asset=[ordered]@{file=$installerName;bytes=(Get-Item -LiteralPath $installer).Length;sha256=$finalSha};authenticode=[ordered]@{status=[string]$sig.Status;publisher=$sig.SignerCertificate.Subject;certificate_thumbprint=$sig.SignerCertificate.Thumbprint;timestamp_authority=$sig.TimeStamperCertificate.Subject};internal_signature_count=$result.signatures.Count;payload_file_count=$payload.file_count;portable=$true;uninstaller=$false;prerequisite='Compatible Windows x64 with Microsoft Edge WebView2 Runtime'}
if ($InstallerRevision -ne 'original') {
  $public['distribution_revision'] = $before.distribution_revision
  $public['installer_source_build'] = $before.installer_source_commit
}
if ($InstallerRevision -eq 'r2') { $public['documentation_source_build'] = $before.documentation_source_commit }
$manifestPath = Join-Path $release $manifestName
[IO.File]::WriteAllText($manifestPath,($public | ConvertTo-Json -Depth 8) + "`n",$utf8)
[IO.File]::WriteAllText((Join-Path $release $checksumsName),"$finalSha  $installerName`n$(Sha $manifestPath)  $manifestName`n",$utf8)

# Same-task disposable installation: exact path, no links, no live owned process.
$exactScope = (Resolve-Path -LiteralPath $scope).Path
if ([IO.Path]::GetDirectoryName($exactScope) -ne [IO.Path]::GetFullPath((Join-Path $project 'tests/private'))) { throw 'Cleanup boundary mismatch' }
$items = @(Get-Item -LiteralPath $exactScope) + @(Get-ChildItem -LiteralPath $exactScope -Recurse -Force)
if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked cleanup input' }
$active = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($exactScope + '\',[StringComparison]::OrdinalIgnoreCase) })
if ($active.Count) { throw 'Owned installer process still active; preserve test root' }
$removedFiles = @($items | Where-Object { -not $_.PSIsContainer }).Count
Remove-Item -LiteralPath $exactScope -Recurse -Force
if (Test-Path -LiteralPath $exactScope) { throw 'Temporary installation not retired' }
[ordered]@{status='passed';final=$public;temporary_files_removed=$removedFiles;test_root_retired=$true;published=$false} | ConvertTo-Json -Depth 8
