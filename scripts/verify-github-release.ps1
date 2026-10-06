param([ValidateSet('original','r1')][string]$InstallerRevision = 'original', [switch]$CurrentOnly)
$ErrorActionPreference = 'Stop'
if ($CurrentOnly -and $InstallerRevision -ne 'r1') { throw 'CurrentOnly requires installer r1' }
# Read-only public GitHub verification of the explicitly approved 1.0.0 release.
# No credentials, publishing, deletion, recompilation, or release-file replacement.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRelease = Join-Path $project 'releases/1.0.0'
$receiptRoot = if ($InstallerRevision -eq 'r1') { Join-Path $localRelease 'installer-r1' } else { $localRelease }
$receiptName = if ($CurrentOnly) { 'github-publication-current-only.json' } else { 'github-publication.json' }
$receiptPath = Join-Path $receiptRoot $receiptName
if (Test-Path -LiteralPath $receiptPath) { throw 'Existing publication receipt is immutable' }
$api = 'https://api.github.com/repos/ChenXing-CyberVenus/Cloudig'
$headers = @{ 'User-Agent'='Cloudig-release-verification'; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2026-03-10' }
$release = Invoke-RestMethod -Uri "$api/releases/tags/v1.0.0" -Headers $headers
$latest = Invoke-RestMethod -Uri "$api/releases/latest" -Headers $headers
if ($release.tag_name -ne 'v1.0.0' -or $release.draft -or $release.prerelease -or $latest.id -ne $release.id) { throw 'Release is not the expected public stable/latest version' }
if ($release.name -ne '采云 V1.0 东方既白 · DawnGlow') { throw 'Release title changed' }
$approvedNotes = [IO.File]::ReadAllText((Join-Path $project 'release/public/v1.0.0.md'))
if ($release.body.Replace("`r`n","`n").TrimEnd() -cne $approvedNotes.Replace("`r`n","`n").TrimEnd()) { throw 'Published notes differ from approved text' }
$expected = @('Cloudig-1.0.0-Setup.exe','Cloudig-1.0.0-release-manifest.json','SHA256SUMS.txt')
$revisionAssets = @('Cloudig-1.0.0-Setup-r1.exe','Cloudig-1.0.0-r1-release-manifest.json','SHA256SUMS-r1.txt')
if ($CurrentOnly) { $expected = $revisionAssets }
elseif ($InstallerRevision -eq 'r1') { $expected += $revisionAssets }
if ($release.assets.Count -ne $expected.Count) { throw 'Unexpected release asset count' }
$assets = @()
foreach ($name in $expected) {
  $asset = @($release.assets | Where-Object name -eq $name)
  if ($asset.Count -ne 1 -or $asset[0].state -ne 'uploaded') { throw "Missing/incomplete asset: $name" }
  $asset = $asset[0]
  $fileRoot = if ($name -in $revisionAssets) { Join-Path $localRelease 'installer-r1' } else { $localRelease }
  $file = Get-Item -LiteralPath (Join-Path $fileRoot $name)
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($asset.size -ne $file.Length -or $asset.digest -ne "sha256:$hash") { throw "Remote asset bytes do not match frozen local file: $name" }
  if ($asset.browser_download_url -ne "https://github.com/ChenXing-CyberVenus/Cloudig/releases/download/v1.0.0/$name") { throw 'Unexpected download URL' }
  $assets += [ordered]@{id=$asset.id;name=$name;bytes=$asset.size;sha256=$hash;github_digest=$asset.digest;url=$asset.browser_download_url}
}
$tag = Invoke-RestMethod -Uri "$api/git/ref/tags/v1.0.0" -Headers $headers
if ($tag.object.type -ne 'commit') { throw 'Inspect non-lightweight tag before proceeding' }
$tree = Invoke-RestMethod -Uri "$api/git/trees/$($tag.object.sha)" -Headers $headers
if ($tree.truncated -or (($tree.tree.path | Sort-Object) -join ',') -cne 'LICENSE,README.md') { throw 'Public source snapshot contains more than the approved documents' }
$documentCommit = $tag.object.sha
if ($InstallerRevision -eq 'r1') {
  $head = Invoke-RestMethod -Uri "$api/git/ref/heads/main" -Headers $headers
  $documentCommit = $head.object.sha
  $mainTree = Invoke-RestMethod -Uri "$api/git/trees/$documentCommit" -Headers $headers
  if ($mainTree.truncated -or (($mainTree.tree.path | Sort-Object) -join ',') -cne 'LICENSE,README.md') { throw 'Public main contains unexpected files' }
}
$documents = @()
foreach ($name in @('README.md','LICENSE')) {
  $content = Invoke-RestMethod -Uri "$api/contents/$($name)?ref=$documentCommit" -Headers $headers
  $bytes = [Convert]::FromBase64String($content.content)
  $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  $local = if ($name -eq 'README.md') { Join-Path $project 'release/public/README.md' } else { Join-Path $project 'LICENSE' }
  if ($sha -ne (Get-FileHash -LiteralPath $local).Hash.ToLowerInvariant()) { throw "Public document changed: $name" }
  $documents += [ordered]@{path=$name;sha256=$sha;blob=$content.sha}
}
$result = [ordered]@{status='published-and-verified';checked_at=[DateTime]::UtcNow.ToString('o');release_id=$release.id;tag=$release.tag_name;tag_commit=$tag.object.sha;public_commit=$documentCommit;published_at=$release.published_at;url=$release.html_url;latest=$true;draft=$false;prerelease=$false;assets=$assets;documents=$documents;local_git_history_uploaded=$false}
if ($InstallerRevision -eq 'r1') { $result['distribution_revision']='installer-r1'; $result['previous_assets_retained']=(-not $CurrentOnly) }
[IO.File]::WriteAllText($receiptPath,($result | ConvertTo-Json -Depth 8) + "`n",[Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 8
