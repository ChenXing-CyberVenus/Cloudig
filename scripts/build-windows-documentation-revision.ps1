param([ValidateSet('r2')][string]$Revision = 'r2')
$ErrorActionPreference = 'Stop'
# This revision restores one guide. Reuse the frozen signed program; overlay only
# the two rendered guides and their two downloadable Markdown counterparts.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = Join-Path $project 'releases/1.0.0'
$baseRoot = Join-Path $releaseRoot 'Cloudig'
$baseManifestPath = Join-Path $releaseRoot 'SHA256-signed-payload.json'
$baseManifest = Get-Content -LiteralPath $baseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$revisionRoot = Join-Path $releaseRoot "installer-$Revision"
if (Test-Path -LiteralPath $revisionRoot) { throw 'Revision already exists; never overwrite a signing handoff' }
$compiler = Join-Path $project 'manager/.cache/inno-setup-7.1.0/compiler/ISCC.exe'
function Sha([string]$Name) { (Get-FileHash -LiteralPath $Name -Algorithm SHA256).Hash.ToLowerInvariant() }
if ((Sha $compiler) -ne 'd06ebd38f38e3cee60a3c50cc45bd449d77e0bc6a5cabc607ea9886808e4de1a' -or (Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid') { throw 'Unexpected or unsigned compiler' }
if ($baseManifest.product_version -ne '1.0.0') { throw 'Wrong original payload version' }
$sourceCommit = (git -C $project rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or (git -C $project status --porcelain)) { throw 'Freeze a clean source commit before packaging' }
& node (Join-Path $PSScriptRoot 'build-bookmark-documents.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Guide source/author fidelity check failed' }
$baseItems = @(Get-Item -LiteralPath $baseRoot) + @(Get-ChildItem -LiteralPath $baseRoot -Recurse -Force)
if (@($baseItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked original payload' }
if (@($baseItems | Where-Object { -not $_.PSIsContainer }).Count -ne $baseManifest.file_count) { throw 'Original payload inventory changed' }
foreach ($file in $baseManifest.files) {
  if ($file.path -match '(^|/)\.\.?(/|$)|[":]' -or $file.path.StartsWith('/')) { throw 'Unsafe original payload path' }
  if ((Sha (Join-Path $baseRoot $file.path)) -ne $file.sha256) { throw "Original payload changed: $($file.path)" }
}
foreach ($entry in $baseManifest.signatures) {
  $sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $baseRoot $entry.path)
  if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate -or $sig.SignerCertificate.Thumbprint -ne $entry.thumbprint) { throw "Original inner signature changed: $($entry.path)" }
}
$replacements = [ordered]@{
  'app/web/pages/document/content/bookmark-zh-CN.json' = 'src/ui/shell/pages/document/content/bookmark-zh-CN.json'
  'app/web/pages/document/content/bookmark-en.json' = 'src/ui/shell/pages/document/content/bookmark-en.json'
  'docs/bookmarks/Cloudig-Bookmarklet-Guide.zh-CN.md' = 'src/ui/documents/bookmarks/zh-CN.md'
  'docs/bookmarks/Cloudig-Bookmarklet-Guide.en.md' = 'src/ui/documents/bookmarks/en.md'
}
foreach ($relative in $replacements.Keys) {
  if ($relative -notin $baseManifest.files.path) { throw "Replacement is not an existing guide: $relative" }
}
$work = Join-Path $revisionRoot 'installer-build'
$overrides = Join-Path $revisionRoot 'payload-overrides'
New-Item -ItemType Directory -Path $revisionRoot,$work,$overrides | Out-Null
$changed = @()
foreach ($relative in $replacements.Keys) {
  $from = Join-Path $project $replacements[$relative]
  $to = Join-Path $overrides $relative
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($to)) | Out-Null
  Copy-Item -LiteralPath $from -Destination $to
  $old = $baseManifest.files | Where-Object path -eq $relative
  $changed += [ordered]@{path=$relative;source=$replacements[$relative];before_sha256=$old.sha256;sha256=(Sha $to);bytes=(Get-Item -LiteralPath $to).Length}
}
$files = @(); $include = @(); $checks = @('function CheckPayloadFiles: String;', 'begin', "  Result := '';" )
foreach ($old in $baseManifest.files) {
  $root = if ($replacements.Contains($old.path)) { $overrides } else { $baseRoot }
  $name = Join-Path $root $old.path
  $files += [ordered]@{path=$old.path;bytes=(Get-Item -LiteralPath $name).Length;sha256=(Sha $name)}
  $relative = $old.path.Replace('/','\')
  $dest = [IO.Path]::GetDirectoryName($relative)
  $include += ('Source: "' + $name + '"; DestDir: "{app}' + $(if ($dest) {'\' + $dest} else {''}) + '"; Flags: ignoreversion')
  $checks += ("  Result := CheckFile('" + $relative.Replace("'","''") + "'); if Result <> '' then Exit;")
}
$checks += 'end;'
$utf8 = [Text.UTF8Encoding]::new($false)
$payloadManifest = [ordered]@{product_version='1.0.0';distribution_revision="documentation-$Revision";source_build=$baseManifest.source_build;documentation_source_commit=$sourceCommit;base_payload_manifest_sha256=(Sha $baseManifestPath);verified_at=[DateTime]::UtcNow.ToString('o');file_count=$files.Count;signatures=$baseManifest.signatures;documentation_changes=$changed;files=$files}
$payloadManifestPath = Join-Path $revisionRoot 'SHA256-signed-payload.json'
[IO.File]::WriteAllText($payloadManifestPath,($payloadManifest | ConvertTo-Json -Depth 10) + "`n",$utf8)
$fileInclude = Join-Path $work 'payload-files.iss'
$checkInclude = Join-Path $work 'payload-checks.iss'
[IO.File]::WriteAllText($fileInclude,($include -join "`n") + "`n",$utf8)
[IO.File]::WriteAllText($checkInclude,($checks -join "`n") + "`n",$utf8)
$compilerArgs = @('--quiet-progress','--no-ide-signtools',"--output-dir=$revisionRoot",'--define=ProductVersion=1.0.0',"--define=InstallerSuffix=-$Revision","--define=ProjectRoot=$project","--define=PayloadRoot=$baseRoot","--define=PayloadFiles=$fileInclude","--define=PayloadChecks=$checkInclude",'--define=VersionMS=65536','--define=VersionLS=0',(Join-Path $project 'release/windows/Cloudig.iss'))
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" }
foreach ($file in $files) {
  $root = if ($replacements.Contains($file.path)) { $overrides } else { $baseRoot }
  if ((Sha (Join-Path $root $file.path)) -ne $file.sha256) { throw 'Payload source changed during compilation' }
}
$name = "Cloudig-1.0.0-Setup-$Revision.exe"
$output = Join-Path $revisionRoot $name
if ((Get-AuthenticodeSignature -LiteralPath $output).Status -ne 'NotSigned') { throw 'Unexpected outer signing state' }
$backupRelative = "installer-build/Cloudig-1.0.0-Setup-$Revision-unsigned.exe"
Copy-Item -LiteralPath $output -Destination (Join-Path $revisionRoot $backupRelative)
$result = [ordered]@{status='awaiting-installer-tests-and-owner-signature';product_version='1.0.0';distribution_revision="documentation-$Revision";installer_source_commit=$sourceCommit;documentation_source_commit=$sourceCommit;installer=[ordered]@{path=$output;bytes=(Get-Item -LiteralPath $output).Length;sha256=(Sha $output);signature='NotSigned'};unsigned_backup=[ordered]@{path=$backupRelative;sha256=(Sha $output)};compiler=[ordered]@{version='7.1.0';sha256=(Sha $compiler)};template_sha256=(Sha (Join-Path $project 'release/windows/Cloudig.iss'));payload_manifest='SHA256-signed-payload.json';payload_manifest_sha256=(Sha $payloadManifestPath);payload_files=$files.Count;internal_signatures_unchanged=$baseManifest.signatures.Count;changed_files=$changed}
[IO.File]::WriteAllText((Join-Path $revisionRoot 'installer-before-signing.json'),($result | ConvertTo-Json -Depth 10) + "`n",$utf8)
$result | ConvertTo-Json -Depth 10
