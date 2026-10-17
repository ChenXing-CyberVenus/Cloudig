param(
    [Parameter(Mandatory=$true)][string]$EvidencePath,
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$CandidateName,
    [switch]$ResumeUnfinished
)
$ErrorActionPreference = 'Stop'
# GPT-6-Astra · 承卷开霁, 2026-09-22. Freeze one tested payload; never overwrite a signed stage.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $project 'artifacts/v1-desktop/app'
$components = @('Cloudig.exe','app','bookmarks','docs','LICENSE','NOTICE.md')
$ownedPe = @('Cloudig.exe','app/Cloudig.dll','app/Cloudig.Desktop.Core.dll','app/Cloudig.Bookmarks.dll')
$provenance = Get-Content -LiteralPath (Join-Path $source 'app/build-provenance.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$provenance.product
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid product version' }
if (-not $provenance.source.working_tree_clean) { throw 'Source build was not clean' }
$releaseRoot = Join-Path $project 'releases'
$versionRoot = Join-Path $releaseRoot $version
if ($CandidateName) {
    if ((Test-Path -LiteralPath $versionRoot) -and ((Get-Item -LiteralPath $versionRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked version directory' }
    $versionRoot = Join-Path $versionRoot $CandidateName
}
$destination = Join-Path $versionRoot 'Cloudig'
if (Test-Path -LiteralPath $versionRoot) {
    if (-not $ResumeUnfinished -or (Test-Path -LiteralPath (Join-Path $versionRoot 'SHA256-before-signing.json'))) { throw "Version already exists; do not overwrite: $versionRoot" }
} elseif ($ResumeUnfinished) { throw 'No unfinished candidate to resume' }
foreach ($p in @($source,$releaseRoot)) {
    if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked path: $p" }
}
$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-Sha([string]$File) {
    $stream = [IO.File]::OpenRead($File); $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
if ((Get-Sha (Join-Path $source 'Cloudig.exe')) -ne $evidence.executable.sha256) { throw 'EXE differs from tested evidence' }
if ((Get-Sha (Join-Path $source 'app/engine/engine.mjs')) -ne $evidence.engine.sha256) { throw 'Engine differs from tested evidence' }
Push-Location $project
try {
    $programCheck = & node --input-type=module -e "import {hashInputs} from './scripts/v1-release-preflight.mjs';const p=hashInputs(process.cwd(),['artifacts/v1-desktop/app/app']);console.log(JSON.stringify({sha:p.aggregate_sha256,files:p.file_count,bytes:p.total_bytes}));"
    if ($LASTEXITCODE -ne 0) { throw 'Program fingerprint failed' }
} finally { Pop-Location }
$program = $programCheck | ConvertFrom-Json
if ($program.sha -ne $evidence.program.aggregate_sha256 -or $program.files -ne $evidence.program.file_count -or $program.bytes -ne $evidence.program.total_bytes) { throw 'Program differs from tested evidence' }

$files = @()
foreach ($component in $components) {
    $entry = Get-Item -LiteralPath (Join-Path $source $component)
    $items = if ($entry.PSIsContainer) { @($entry) + @(Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force) } else { @($entry) }
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked input: $($item.FullName)" }
        if ($item.PSIsContainer) { continue }
        $relative = $item.FullName.Substring($source.Length + 1).Replace('\','/')
        $files += [ordered]@{path=$relative;bytes=$item.Length;sha256=(Get-Sha $item.FullName)}
    }
}
$signingTargets = @()
foreach ($relative in $ownedPe) {
    $file = Get-Item -LiteralPath (Join-Path $source $relative)
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'NotSigned') { throw "Unexpected existing signature on $relative : $($signature.Status)" }
    if ($file.VersionInfo.ProductVersion -ne ($version + '+' + $provenance.source.commit)) { throw "Owned PE build/version mismatch: $relative" }
    $signingTargets += [ordered]@{path=$relative;status_before=[string]$signature.Status;product=$file.VersionInfo.ProductName;product_version=$file.VersionInfo.ProductVersion;sha256_before=(Get-Sha $file.FullName)}
}
$unexpectedOwned = @($files | Where-Object { $_.path -match '(^|/)Cloudig[^/]*\.(exe|dll)$' -and $_.path -notin $ownedPe })
if ($unexpectedOwned.Count) { throw 'Review additional self-owned PE files before freezing this version' }

if ($ResumeUnfinished) {
    $candidateItems = @((Get-Item -LiteralPath $versionRoot)) + @(Get-ChildItem -LiteralPath $versionRoot -Recurse -Force)
    if (@($candidateItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked unfinished candidate' }
    $candidateFiles = @(Get-ChildItem -LiteralPath $destination -Recurse -File)
    if ($candidateFiles.Count -ne $files.Count) { throw 'Unfinished candidate file set differs' }
    foreach ($relative in $ownedPe) { if ((Get-AuthenticodeSignature -LiteralPath (Join-Path $destination $relative)).Status -ne 'NotSigned') { throw 'Never resume a signed candidate' } }
} else {
    New-Item -ItemType Directory -Path $destination | Out-Null
    foreach ($component in $components) { Copy-Item -LiteralPath (Join-Path $source $component) -Destination (Join-Path $destination $component) -Recurse }
}
foreach ($file in $files) {
    if ((Get-Sha (Join-Path $destination $file.path)) -ne $file.sha256 -or (Get-Sha (Join-Path $source $file.path)) -ne $file.sha256) { throw "Copy/source changed: $($file.path)" }
}
if ($ResumeUnfinished) { Write-Output "Verified $($files.Count) existing unsigned files. Checking the interrupted backup." }
else { Write-Output "Copied $($files.Count) tested program files. Creating unsigned backup." }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $versionRoot "Cloudig-$version-unsigned-backup.zip"
if (-not $ResumeUnfinished) { [IO.Compression.ZipFile]::CreateFromDirectory($destination,$archivePath,[IO.Compression.CompressionLevel]::Optimal,$true) }
$byPath = @{}; foreach ($file in $files) { $byPath[$file.path] = $file }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
$seen = @{}
try {
    foreach ($entry in $zip.Entries) {
        $entryName = $entry.FullName.Replace('\','/') # .NET Framework and modern .NET differ on Windows.
        if ($entryName.EndsWith('/')) { continue }
        if (-not $entryName.StartsWith('Cloudig/')) { throw 'Unexpected ZIP root' }
        $relative = $entryName.Substring(8)
        if (-not $byPath.ContainsKey($relative) -or $seen.ContainsKey($relative)) { throw "Unexpected ZIP entry: $relative" }
        $expected = $byPath[$relative]; $stream = $entry.Open(); $hash = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $hash.Dispose(); $stream.Dispose() }
        if ($actual -ne $expected.sha256 -or $entry.Length -ne $expected.bytes) { throw "ZIP mismatch: $relative" }
        $seen[$relative] = $true
    }
    if ($seen.Count -ne $files.Count) { throw 'ZIP file count mismatch' }
} finally { $zip.Dispose() }
[long]$totalBytes = 0
foreach ($file in $files) { $totalBytes += [long]$file.bytes }
$manifest = [ordered]@{
    status='awaiting-owner-signature';product_version=$version;prepared_at=[DateTime]::UtcNow.ToString('o')
    operator='GPT-6-Astra·奥思·承卷开霁 Osis.ScrollborneDawn';source_build=$provenance.source
    source_inputs=$provenance.inputs;source_evidence=$EvidencePath;components=$components
    file_count=$files.Count;total_bytes=$totalBytes
    signing_targets=$signingTargets;third_party_pe_count=@($files | Where-Object { $_.path -match '\.(exe|dll)$' -and $_.path -notin $ownedPe }).Count
    unsigned_backup=[ordered]@{path=[IO.Path]::GetFileName($archivePath);bytes=(Get-Item -LiteralPath $archivePath).Length;sha256=(Get-Sha $archivePath);all_zip_entries_verified=$true}
    files=$files
}
[IO.File]::WriteAllText((Join-Path $versionRoot 'SHA256-before-signing.json'),($manifest | ConvertTo-Json -Depth 12) + "`n",[Text.UTF8Encoding]::new($false))
[ordered]@{directory=$versionRoot;files=$manifest.file_count;bytes=$manifest.total_bytes;signing_targets=$ownedPe;backup=$manifest.unsigned_backup} | ConvertTo-Json -Depth 5
