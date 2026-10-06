[CmdletBinding()]
param(
    [string]$DotnetExecutable = "",
    [string]$ReleaseName = "",
    [string]$WebView2Installer = "",
    [switch]$NoRestore,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Assert-ChildPath([string]$Candidate, [string]$Parent, [string]$Label, [bool]$AllowEqual = $false) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($AllowEqual -and $resolvedCandidate -ieq $resolvedParent) { return }
    if (-not $resolvedCandidate.StartsWith($resolvedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escaped its allowed directory: $resolvedCandidate"
    }
}

function Assert-NoReparseComponents([string]$Candidate, [string]$Boundary, [string]$Label) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedBoundary = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    Assert-ChildPath $resolvedCandidate $resolvedBoundary $Label $true
    $cursor = $resolvedCandidate
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point or junction: $cursor"
            }
        }
        if ($cursor -ieq $resolvedBoundary) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ieq $cursor) {
            throw "$Label could not be traced back to its allowed boundary: $resolvedBoundary"
        }
        $cursor = $parent
    }
}

function Assert-NoReparseTree([string]$Root, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue([IO.Path]::GetFullPath($Root))
    while ($pending.Count -gt 0) {
        $currentPath = $pending.Dequeue()
        $current = Get-Item -LiteralPath $currentPath -Force
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label contains a reparse point or junction: $currentPath"
        }
        if (-not $current.PSIsContainer) { continue }
        foreach ($child in @(Get-ChildItem -LiteralPath $currentPath -Force)) {
            $pending.Enqueue($child.FullName)
        }
    }
}

function Remove-SafePath([string]$Candidate, [string]$Boundary, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Candidate)) { return }
    Assert-NoReparseComponents $Candidate $Boundary $Label
    Assert-NoReparseTree $Candidate $Label
    Remove-Item -LiteralPath $Candidate -Recurse -Force
}

function Assert-RuntimeLockMatchesReleaseSpec($RuntimeLock, $ReleaseSpec) {
    $declared = $ReleaseSpec.windows_candidate.runtime_lock
    $comparisons = @(
        @("format", [string]$RuntimeLock.format, [string]$declared.format),
        @("version", [string]$RuntimeLock.version, [string]$declared.version),
        @("Node version", [string]$RuntimeLock.node.version, [string]$declared.node_version),
        @(".NET target framework", [string]$RuntimeLock.dotnet.target_framework, [string]$declared.target_framework),
        @(".NET runtime identifier", [string]$RuntimeLock.dotnet.runtime_identifier, [string]$declared.runtime_identifier),
        @("WebView2 SDK version", [string]$RuntimeLock.webview2.sdk_version, [string]$declared.webview2_sdk_version),
        @("WebView2 runtime channel", [string]$RuntimeLock.webview2.runtime_channel, [string]$declared.webview2_runtime_channel),
        @("WebView2 offline fallback", [string]$RuntimeLock.webview2.distribution.offline_fallback, [string]$declared.webview2_offline_fallback),
        @("WebView2 Authenticode signer", [string]$RuntimeLock.webview2.distribution.authenticode_signer_cn, [string]$declared.webview2_installer_authenticode_signer)
    )
    foreach ($comparison in $comparisons) {
        if ($comparison[1] -cne $comparison[2]) {
            throw "runtime-lock and release-spec projection disagree for $($comparison[0])."
        }
    }
    if ([bool]$RuntimeLock.dotnet.self_contained -ne [bool]$declared.self_contained -or
        [bool]$RuntimeLock.webview2.distribution.bundled_by_default -ne [bool]$declared.webview2_installer_bundled_by_default -or
        [bool]$RuntimeLock.webview2.distribution.auto_execute -ne [bool]$declared.webview2_installer_auto_execute) {
        throw "runtime-lock and release-spec projection disagree for Boolean distribution policy."
    }
    $lockApproved = @($RuntimeLock.webview2.distribution.approved_installers)
    $specApproved = @($declared.webview2_approved_installers)
    if (($lockApproved | ConvertTo-Json -Compress) -cne ($specApproved | ConvertTo-Json -Compress)) {
        throw "runtime-lock and release-spec projection disagree for the WebView2 installer allowlist."
    }
}

function Get-PlainReleaseFiles([string]$Root, [string]$Label) {
    Assert-NoReparseTree $Root $Label
    $result = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName)) {
        $relative = ($file.FullName.Substring($Root.Length) -replace '^[\\/]+', '').Replace("\", "/")
        $result += [pscustomobject]@{
            path = $relative
            bytes = [long]$file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return @($result)
}

function Invoke-WindowsReleaseVerifier(
    [string]$VerifierPath,
    [string]$Directory,
    [string]$Archive,
    [string]$ReleaseName,
    [string]$Boundary
) {
    $verificationJson = (& $VerifierPath -Directory $Directory -Archive $Archive -ReleaseName $ReleaseName -Boundary $Boundary | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($verificationJson)) { throw "Windows release verifier returned no result." }
    return ($verificationJson | ConvertFrom-Json)
}

function Commit-ReleaseTransaction(
    [string]$StagedOutput,
    [string]$StagedArchive,
    [string]$FinalOutput,
    [string]$FinalArchive,
    [string]$TransactionRoot,
    [string]$DistBoundary,
    [string]$VerifierPath,
    [string]$ReleaseName,
    [string]$FailureInjection = ""
) {
    foreach ($entry in @(
        @($StagedOutput, "staged release output"),
        @($StagedArchive, "staged release archive"),
        @($FinalOutput, "final release output"),
        @($FinalArchive, "final release archive"),
        @($TransactionRoot, "release transaction")
    )) {
        Assert-NoReparseComponents $entry[0] $DistBoundary $entry[1]
    }
    Assert-NoReparseTree $StagedOutput "staged release output"
    Assert-NoReparseTree $StagedArchive "staged release archive"
    if (-not (Test-Path -LiteralPath $StagedOutput -PathType Container) -or -not (Test-Path -LiteralPath $StagedArchive -PathType Leaf)) {
        throw "Release transaction is missing its staged directory or archive."
    }
    $backupOutput = Join-Path $TransactionRoot "rollback-output"
    $backupArchive = Join-Path $TransactionRoot "rollback-archive.zip"
    $backedUpOutput = $false
    $backedUpArchive = $false
    $installedOutput = $false
    $installedArchive = $false
    try {
        if (Test-Path -LiteralPath $FinalOutput) {
            Assert-NoReparseTree $FinalOutput "existing final release output"
            Move-Item -LiteralPath $FinalOutput -Destination $backupOutput
            $backedUpOutput = $true
        }
        if (Test-Path -LiteralPath $FinalArchive) {
            Assert-NoReparseTree $FinalArchive "existing final release archive"
            Move-Item -LiteralPath $FinalArchive -Destination $backupArchive
            $backedUpArchive = $true
        }
        if ($FailureInjection -ceq "after_backup") { throw "Synthetic release transaction failure after backup." }
        Move-Item -LiteralPath $StagedOutput -Destination $FinalOutput
        $installedOutput = $true
        if ($FailureInjection -ceq "after_output") { throw "Synthetic release transaction failure after output install." }
        Move-Item -LiteralPath $StagedArchive -Destination $FinalArchive
        $installedArchive = $true
        if ($FailureInjection -ceq "after_archive") { throw "Synthetic release transaction failure after archive install." }
        $null = Invoke-WindowsReleaseVerifier $VerifierPath $FinalOutput $FinalArchive $ReleaseName $DistBoundary
        if ($FailureInjection -ceq "after_verify") { throw "Synthetic release transaction failure after verification." }
    }
    catch {
        $originalError = $_
        try {
            if (($installedOutput -or $backedUpOutput) -and (Test-Path -LiteralPath $FinalOutput)) {
                Remove-SafePath $FinalOutput $DistBoundary "failed transaction output"
            }
            if (($installedArchive -or $backedUpArchive) -and (Test-Path -LiteralPath $FinalArchive)) {
                Remove-SafePath $FinalArchive $DistBoundary "failed transaction archive"
            }
            if ($backedUpOutput) { Move-Item -LiteralPath $backupOutput -Destination $FinalOutput }
            if ($backedUpArchive) { Move-Item -LiteralPath $backupArchive -Destination $FinalArchive }
        }
        catch {
            throw "Release commit failed and rollback also failed. Recovery material remains in $TransactionRoot. Commit error: $($originalError.Exception.Message). Rollback error: $($_.Exception.Message)"
        }
        throw $originalError
    }
}

function Complete-ReleaseTransactionCleanup(
    [string]$TransactionRoot,
    [string]$DistBoundary,
    [bool]$TransactionCommitted
) {
    if (-not (Test-Path -LiteralPath $TransactionRoot)) { return }
    if ($TransactionCommitted) {
        # The new directory and ZIP have already passed the verifier at their
        # final paths. The old candidate is now rollback material, not an
        # incomplete rollback; remove the entire private transaction tree.
        Remove-SafePath $TransactionRoot $DistBoundary "committed release transaction cleanup"
        return
    }
    $rollbackOutput = Join-Path $TransactionRoot "rollback-output"
    $rollbackArchive = Join-Path $TransactionRoot "rollback-archive.zip"
    if ((Test-Path -LiteralPath $rollbackOutput) -or (Test-Path -LiteralPath $rollbackArchive)) {
        Write-Warning "Release recovery material was preserved after an incomplete rollback: $TransactionRoot"
        return
    }
    Remove-SafePath $TransactionRoot $DistBoundary "release transaction cleanup"
}

$managerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$projectRoot = [IO.Path]::GetFullPath((Join-Path $managerRoot ".."))
$releaseSpecPath = Join-Path $projectRoot "release-spec.json"
$runtimeLockPath = Join-Path $managerRoot "windows\runtime-lock.json"
$desktopProject = Join-Path $managerRoot "windows\Cloudig.Desktop\Cloudig.Desktop.csproj"
$bookmarkManifestPath = Join-Path $managerRoot "bookmarks\bookmark-package.json"
$iconBuilderPath = Join-Path $managerRoot "scripts\build-windows-icon.ps1"
$buildInputPath = Join-Path $managerRoot "scripts\windows-build-inputs.mjs"
$releaseVerifierPath = Join-Path $managerRoot "scripts\verify-windows-release.ps1"

foreach ($sourceEntry in @($releaseSpecPath, $runtimeLockPath, $desktopProject, $bookmarkManifestPath, $iconBuilderPath, $buildInputPath, $releaseVerifierPath)) {
    Assert-NoReparseComponents $sourceEntry $projectRoot "Windows publisher source"
    if (-not (Test-Path -LiteralPath $sourceEntry -PathType Leaf)) { throw "Windows publisher source is missing: $sourceEntry" }
}
$releaseSpec = Get-Content -LiteralPath $releaseSpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeLock = Get-Content -LiteralPath $runtimeLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-RuntimeLockMatchesReleaseSpec $runtimeLock $releaseSpec

if ([string]::IsNullOrWhiteSpace($ReleaseName)) { $ReleaseName = [string]$releaseSpec.windows_candidate.release_name }
if ($ReleaseName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Unsafe Cloudig release name: $ReleaseName" }
if ($ReleaseName -cne [string]$releaseSpec.windows_candidate.release_name) {
    throw "The Windows publisher may replace only the current release-spec candidate: $($releaseSpec.windows_candidate.release_name)"
}

$cacheRoot = Join-Path $managerRoot ".cache"
$distRoot = Join-Path $managerRoot "dist"
$finalOutputRoot = Join-Path $distRoot $ReleaseName
$finalArchivePath = Join-Path $distRoot "$ReleaseName.zip"
foreach ($entry in @(
    @($cacheRoot, $managerRoot, "runtime cache"),
    @($distRoot, $managerRoot, "distribution root"),
    @($finalOutputRoot, $distRoot, "final release output"),
    @($finalArchivePath, $distRoot, "final release archive")
)) {
    Assert-NoReparseComponents $entry[0] $entry[1] $entry[2]
}
foreach ($existing in @($finalOutputRoot, $finalArchivePath)) {
    if (-not (Test-Path -LiteralPath $existing)) { continue }
    if (-not $Force) { throw "Release output already exists: $existing. Re-run with -Force only after confirming it may be replaced." }
    Assert-NoReparseComponents $existing $distRoot "existing current release"
    Assert-NoReparseTree $existing "existing current release"
}

# Cache writes, deletions, and extraction are guarded both before and after use.
Assert-NoReparseComponents $cacheRoot $managerRoot "runtime cache"
if (Test-Path -LiteralPath $cacheRoot) { Assert-NoReparseTree $cacheRoot "runtime cache" }
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
Assert-NoReparseComponents $cacheRoot $managerRoot "runtime cache"
Assert-NoReparseTree $cacheRoot "runtime cache"
Assert-NoReparseComponents $distRoot $managerRoot "distribution root"
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-NoReparseComponents $distRoot $managerRoot "distribution root"

$approvedInstallerProperty = $runtimeLock.webview2.distribution.PSObject.Properties["approved_installers"]
if ($null -eq $approvedInstallerProperty) { throw "runtime-lock WebView2 distribution must declare approved_installers." }
$approvedWebView2Installers = @($approvedInstallerProperty.Value)
$seenApprovedWebView2Installers = @()
foreach ($approvedInstaller in $approvedWebView2Installers) {
    $approvedDigest = [string]$approvedInstaller
    if ($approvedDigest -cnotmatch '^[0-9a-f]{64}$') { throw "runtime-lock approved_installers must contain lowercase SHA-256 values." }
    if ($seenApprovedWebView2Installers -ccontains $approvedDigest) { throw "runtime-lock approved_installers contains duplicate SHA-256: $approvedDigest" }
    $seenApprovedWebView2Installers += $approvedDigest
}

$hasWebView2Installer = -not [string]::IsNullOrWhiteSpace($WebView2Installer)
$resolvedWebView2Installer = ""
$expectedWebView2InstallerHash = ""
$webView2SignerSubject = ""
$webView2SignerThumbprint = ""
$webView2ProductName = ""
$webView2FileDescription = ""
$webView2OriginalFilename = ""
if ($hasWebView2Installer) {
    $resolvedWebView2Installer = [IO.Path]::GetFullPath($WebView2Installer)
    if (-not (Test-Path -LiteralPath $resolvedWebView2Installer -PathType Leaf)) { throw "WebView2 offline installer does not exist: $resolvedWebView2Installer" }
    $installerItem = Get-Item -LiteralPath $resolvedWebView2Installer -Force
    if (($installerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "WebView2 offline installer must be a plain file." }
    $expectedInstallerName = [string]$runtimeLock.webview2.distribution.installer_filename
    if ([IO.Path]::GetFileName($resolvedWebView2Installer) -cne $expectedInstallerName) { throw "WebView2 offline installer must be named $expectedInstallerName." }
    $actualInstallerHash = (Get-FileHash -LiteralPath $resolvedWebView2Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($approvedWebView2Installers -cnotcontains $actualInstallerHash) { throw "WebView2 offline installer SHA-256 is not approved by manager/windows/runtime-lock.json: $actualInstallerHash" }
    $expectedWebView2InstallerHash = $actualInstallerHash
    $installerSignature = Get-AuthenticodeSignature -LiteralPath $resolvedWebView2Installer
    if ($installerSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $installerSignature.SignerCertificate -or
        [string]$installerSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)') {
        throw "WebView2 offline installer must have a valid Microsoft Corporation Authenticode signature."
    }
    $installerVersionInfo = $installerItem.VersionInfo
    $webView2ProductName = [string]$installerVersionInfo.ProductName
    $webView2FileDescription = [string]$installerVersionInfo.FileDescription
    $webView2OriginalFilename = [string]$installerVersionInfo.OriginalFilename
    if ($webView2ProductName -notmatch '(?i)WebView2' -or $webView2ProductName -notmatch '(?i)Runtime' -or
        $webView2FileDescription -notmatch '(?i)WebView2' -or $webView2FileDescription -notmatch '(?i)Runtime') {
        throw "WebView2 offline installer version metadata does not identify a WebView2 Runtime product."
    }
    $webView2SignerSubject = [string]$installerSignature.SignerCertificate.Subject
    $webView2SignerThumbprint = ([string]$installerSignature.SignerCertificate.Thumbprint).ToUpperInvariant()
}

$nodeArchive = Join-Path $cacheRoot ([string]$runtimeLock.node.archive)
$nodeExtractRoot = Join-Path $cacheRoot ("node-v" + $runtimeLock.node.version + "-win-x64")
$nodeExecutable = Join-Path $nodeExtractRoot "node.exe"
$nodeLicense = Join-Path $nodeExtractRoot ([string]$runtimeLock.node.license)
foreach ($cacheEntry in @($nodeArchive, $nodeExtractRoot, $nodeExecutable, $nodeLicense)) {
    Assert-NoReparseComponents $cacheEntry $cacheRoot "runtime cache entry"
}
if (-not (Test-Path -LiteralPath $nodeArchive -PathType Leaf)) {
    if (Test-Path -LiteralPath $nodeArchive) { throw "Node.js cache archive is not a plain file: $nodeArchive" }
    $partialArchive = "$nodeArchive.download"
    Assert-NoReparseComponents $partialArchive $cacheRoot "partial Node.js download"
    Remove-SafePath $partialArchive $cacheRoot "partial Node.js download"
    Assert-NoReparseComponents $partialArchive $cacheRoot "partial Node.js download"
    Invoke-WebRequest -UseBasicParsing -Uri $runtimeLock.node.url -OutFile $partialArchive
    Assert-NoReparseComponents $partialArchive $cacheRoot "partial Node.js download"
    Assert-NoReparseTree $partialArchive "partial Node.js download"
    Assert-NoReparseComponents $nodeArchive $cacheRoot "Node.js cache archive"
    Move-Item -LiteralPath $partialArchive -Destination $nodeArchive
}
Assert-NoReparseComponents $nodeArchive $cacheRoot "Node.js cache archive"
Assert-NoReparseTree $nodeArchive "Node.js cache archive"
$archiveHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($archiveHash -ne [string]$runtimeLock.node.sha256) { throw "Node.js archive hash mismatch. Expected $($runtimeLock.node.sha256), got $archiveHash" }

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    if (Test-Path -LiteralPath $nodeExtractRoot) { Remove-SafePath $nodeExtractRoot $cacheRoot "incomplete Node.js extraction" }
    $extractTemporary = Join-Path $cacheRoot ("extract-" + [Guid]::NewGuid().ToString("N"))
    Assert-NoReparseComponents $extractTemporary $cacheRoot "temporary runtime extraction"
    New-Item -ItemType Directory -Path $extractTemporary | Out-Null
    Assert-NoReparseComponents $extractTemporary $cacheRoot "temporary runtime extraction"
    Assert-NoReparseTree $extractTemporary "temporary runtime extraction"
    try {
        Assert-NoReparseComponents $extractTemporary $cacheRoot "temporary runtime extraction"
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extractTemporary
        Assert-NoReparseComponents $extractTemporary $cacheRoot "temporary runtime extraction"
        Assert-NoReparseTree $extractTemporary "temporary runtime extraction"
        $expanded = Join-Path $extractTemporary ("node-v" + $runtimeLock.node.version + "-win-x64")
        Assert-NoReparseComponents $expanded $extractTemporary "verified Node.js extraction"
        if (-not (Test-Path -LiteralPath (Join-Path $expanded "node.exe") -PathType Leaf)) { throw "The verified Node.js archive did not contain the expected Windows runtime." }
        Assert-NoReparseComponents $nodeExtractRoot $cacheRoot "Node.js runtime cache"
        Move-Item -LiteralPath $expanded -Destination $nodeExtractRoot
        Assert-NoReparseComponents $nodeExtractRoot $cacheRoot "Node.js runtime cache"
        Assert-NoReparseTree $nodeExtractRoot "Node.js runtime cache"
    }
    finally {
        if (Test-Path -LiteralPath $extractTemporary) { Remove-SafePath $extractTemporary $cacheRoot "temporary runtime extraction" }
    }
}
Assert-NoReparseComponents $nodeExtractRoot $cacheRoot "Node.js runtime cache"
Assert-NoReparseTree $nodeExtractRoot "Node.js runtime cache"
$nodeHash = (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeHash -ne [string]$runtimeLock.node.node_exe_sha256) { throw "Node.js executable hash mismatch. Expected $($runtimeLock.node.node_exe_sha256), got $nodeHash" }
if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) { throw "Node.js license file is missing from the verified runtime." }

if ([string]::IsNullOrWhiteSpace($DotnetExecutable)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CLOUDIG_DOTNET) -and (Test-Path -LiteralPath $env:CLOUDIG_DOTNET -PathType Leaf)) {
        $DotnetExecutable = [IO.Path]::GetFullPath($env:CLOUDIG_DOTNET)
    }
    else {
        $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($null -eq $dotnetCommand) { throw "A .NET 10 SDK is required to build Cloudig. Pass -DotnetExecutable or set CLOUDIG_DOTNET." }
        $DotnetExecutable = $dotnetCommand.Source
    }
}
if (-not (Test-Path -LiteralPath $DotnetExecutable -PathType Leaf)) { throw "The selected dotnet executable does not exist: $DotnetExecutable" }

function Invoke-BuildInputSnapshot {
    $json = (& $nodeExecutable $buildInputPath --json | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) { throw "Windows build input inventory failed." }
    return [pscustomobject]@{ json = $json; value = ($json | ConvertFrom-Json) }
}

# This first inventory is a pre-build gate. It prevents MSBuild from observing
# untracked compilation inputs or source reparse points.
$null = Invoke-BuildInputSnapshot
& $iconBuilderPath | Out-Host
$buildInputsSnapshot = Invoke-BuildInputSnapshot
$buildInputs = $buildInputsSnapshot.value

& $nodeExecutable (Join-Path $managerRoot "scripts\verify-bookmark-package.mjs")
if ($LASTEXITCODE -ne 0) { throw "The frozen bookmark package verification failed." }
$bookmarkPackage = Get-Content -LiteralPath $bookmarkManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bookmarkPackage.version -ne $releaseSpec.windows_candidate.bookmark_package_version -or
    $bookmarkPackage.bookmark_set_version -ne $releaseSpec.windows_candidate.packaged_bookmark_set_version -or
    [int]$bookmarkPackage.variant_count -ne [int]$releaseSpec.windows_candidate.packaged_variant_count) {
    throw "Bookmark package metadata does not match release-spec.json."
}

$transactionRoot = Join-Path $distRoot (".staging-" + $ReleaseName + "-" + [Guid]::NewGuid().ToString("N"))
$outputRoot = Join-Path $transactionRoot $ReleaseName
$archivePath = Join-Path $transactionRoot "$ReleaseName.zip"
$transactionCommitted = $false
Assert-NoReparseComponents $transactionRoot $distRoot "release transaction"
New-Item -ItemType Directory -Path $transactionRoot | Out-Null
Assert-NoReparseComponents $transactionRoot $distRoot "release transaction"
Assert-NoReparseTree $transactionRoot "release transaction"
try {
    $publishArguments = @(
        "publish", $desktopProject,
        "--configuration", "Release",
        "--runtime", "win-x64",
        "--self-contained", "true",
        "--output", $outputRoot,
        "/p:PublishSingleFile=true",
        "/p:DebugSymbols=false",
        "/p:DebugType=None",
        "/p:NuGetAudit=false"
    )
    if ($NoRestore) { $publishArguments += "--no-restore" }
    & $DotnetExecutable @publishArguments
    if ($LASTEXITCODE -ne 0) { throw "Cloudig Windows publish failed with exit code $LASTEXITCODE" }
    Assert-NoReparseComponents $outputRoot $transactionRoot "published release output"
    Assert-NoReparseTree $outputRoot "published release output"

    # Project globs may have copied private or untracked files. Delete every
    # mapped target root, then reconstruct the payload from the Git whitelist.
    foreach ($relative in @(
        "web", "engine\manager", "engine\library", "engine\parser",
        "engine\schema", "engine\reader", "payload\bookmarks",
        "BOOKMARKLET_CHANGELOG.md", "LICENSE.txt", "runtime-lock.json"
    )) {
        Remove-SafePath (Join-Path $outputRoot $relative) $outputRoot "published mapped target"
    }
    foreach ($inputFile in @($buildInputs.files)) {
        if ($null -eq $inputFile.target -or [string]::IsNullOrWhiteSpace([string]$inputFile.target)) { continue }
        $sourceFile = [IO.Path]::GetFullPath((Join-Path $projectRoot ([string]$inputFile.source).Replace("/", "\")))
        $publishedFile = [IO.Path]::GetFullPath((Join-Path $outputRoot ([string]$inputFile.target).Replace("/", "\")))
        Assert-NoReparseComponents $sourceFile $projectRoot "Windows build input"
        Assert-ChildPath $publishedFile $outputRoot "Windows package target"
        New-Item -ItemType Directory -Path (Split-Path -Parent $publishedFile) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $publishedFile
        if ((Get-Item -LiteralPath $publishedFile).Length -ne [long]$inputFile.bytes -or
            (Get-FileHash -LiteralPath $publishedFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$inputFile.sha256) {
            throw "Published Git-whitelisted input drifted: $($inputFile.target)"
        }
    }

    $bundledNodeRoot = Join-Path $outputRoot "runtime\node"
    New-Item -ItemType Directory -Path $bundledNodeRoot -Force | Out-Null
    Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $bundledNodeRoot "node.exe")
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $bundledNodeRoot "LICENSE.node.txt")
    $reportedNodeVersion = (& (Join-Path $bundledNodeRoot "node.exe") --version).Trim()
    if ($reportedNodeVersion -ne "v$($runtimeLock.node.version)") { throw "Bundled Node.js reported $reportedNodeVersion instead of v$($runtimeLock.node.version)" }

    $webView2InstallerBundled = $false
    if ($hasWebView2Installer) {
        $prerequisiteRoot = Join-Path $outputRoot "prerequisites"
        $installerTarget = Join-Path $prerequisiteRoot ([string]$runtimeLock.webview2.distribution.installer_filename)
        Assert-ChildPath $installerTarget $outputRoot "WebView2 prerequisite"
        New-Item -ItemType Directory -Path $prerequisiteRoot -Force | Out-Null
        Copy-Item -LiteralPath $resolvedWebView2Installer -Destination $installerTarget
        $copiedInstallerHash = (Get-FileHash -LiteralPath $installerTarget -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($copiedInstallerHash -ne $expectedWebView2InstallerHash) { throw "Copied WebView2 offline installer hash mismatch." }
        $copiedInstallerSignature = Get-AuthenticodeSignature -LiteralPath $installerTarget
        if ($copiedInstallerSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
            $null -eq $copiedInstallerSignature.SignerCertificate -or
            ([string]$copiedInstallerSignature.SignerCertificate.Thumbprint).ToUpperInvariant() -cne $webView2SignerThumbprint) {
            throw "Copied WebView2 offline installer lost its valid Microsoft Authenticode identity."
        }
        $copiedVersionInfo = (Get-Item -LiteralPath $installerTarget -Force).VersionInfo
        if ([string]$copiedVersionInfo.ProductName -cne $webView2ProductName -or
            [string]$copiedVersionInfo.FileDescription -cne $webView2FileDescription -or
            [string]$copiedVersionInfo.OriginalFilename -cne $webView2OriginalFilename) {
            throw "Copied WebView2 offline installer lost its approved product identity."
        }
        [ordered]@{
            format = "cloudig/webview2-offline-prerequisite"
            version = "0.2.0"
            architecture = "x64"
            installer = [IO.Path]::GetFileName($installerTarget)
            sha256 = $copiedInstallerHash
            authenticode_status = "Valid"
            signer_subject = $webView2SignerSubject
            signer_thumbprint = $webView2SignerThumbprint
            product_name = $webView2ProductName
            file_description = $webView2FileDescription
            original_filename = $webView2OriginalFilename
            install_arguments = @($runtimeLock.webview2.distribution.silent_install_arguments)
            auto_execute = $false
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $prerequisiteRoot "webview2-runtime.json") -Encoding UTF8
        $webView2InstallerBundled = $true
    }

    Assert-NoReparseTree $outputRoot "completed staged release output"
    $postBuildInputs = Invoke-BuildInputSnapshot
    if ($postBuildInputs.json -cne $buildInputsSnapshot.json) { throw "Windows build inputs changed while the release was being built." }

    $expectedPaths = @{}
    foreach ($inputFile in @($buildInputs.files)) {
        if ($null -ne $inputFile.target -and -not [string]::IsNullOrWhiteSpace([string]$inputFile.target)) {
            $targetPath = [string]$inputFile.target
            $expectedPaths[$targetPath.ToLowerInvariant()] = $targetPath
        }
    }
    foreach ($generated in @(
        "Cloudig.exe",
        "Microsoft.Web.WebView2.Core.xml",
        "Microsoft.Web.WebView2.WinForms.xml",
        "Microsoft.Web.WebView2.Wpf.xml",
        "runtime/node/node.exe",
        "runtime/node/LICENSE.node.txt"
    )) { $expectedPaths[$generated.ToLowerInvariant()] = $generated }
    if ($webView2InstallerBundled) {
        foreach ($generated in @(
            "prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
            "prerequisites/webview2-runtime.json"
        )) { $expectedPaths[$generated.ToLowerInvariant()] = $generated }
    }
    $manifestFiles = @(Get-PlainReleaseFiles $outputRoot "staged release payload")
    if ($manifestFiles.Count -ne $expectedPaths.Count) { throw "Staged Windows package contains a non-permitted file count." }
    foreach ($file in $manifestFiles) {
        $key = $file.path.ToLowerInvariant()
        if (-not $expectedPaths.ContainsKey($key) -or $expectedPaths[$key] -cne $file.path) {
            throw "Staged Windows package contains a non-permitted path: $($file.path)"
        }
    }

    $releaseManifest = [ordered]@{
        format = "cloudig/windows-release-manifest"
        version = [string]$releaseSpec.windows_candidate.release_manifest_version
        release = $ReleaseName
        architecture = [string]$releaseSpec.windows_candidate.architecture
        node_version = $runtimeLock.node.version
        bookmark_set_version = $bookmarkPackage.bookmark_set_version
        bookmark_package_version = $bookmarkPackage.version
        bookmark_variant_count = [int]$bookmarkPackage.variant_count
        webview2_offline_installer_bundled = $webView2InstallerBundled
        build_inputs = $buildInputs
        components = [ordered]@{
            cloudig = [string]$releaseSpec.product.version
            parser = [string]$releaseSpec.components.parser
            reader = [string]$releaseSpec.components.reader
            library = [string]$releaseSpec.components.library
            parse_state = [string]$releaseSpec.components.parse_state
            conversation_schemas = @(
                [string]$releaseSpec.components.conversation_schemas.flat,
                [string]$releaseSpec.components.conversation_schemas.branches
            )
        }
        files = @($manifestFiles)
    }
    $releaseManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputRoot "release-manifest.json") -Encoding UTF8

    Assert-NoReparseComponents $archivePath $transactionRoot "staged release archive"
    Compress-Archive -LiteralPath $outputRoot -DestinationPath $archivePath -CompressionLevel Optimal
    Assert-NoReparseComponents $archivePath $transactionRoot "staged release archive"
    Assert-NoReparseTree $archivePath "staged release archive"
    $null = Invoke-WindowsReleaseVerifier $releaseVerifierPath $outputRoot $archivePath $ReleaseName $transactionRoot

    Commit-ReleaseTransaction $outputRoot $archivePath $finalOutputRoot $finalArchivePath $transactionRoot $distRoot $releaseVerifierPath $ReleaseName
    $transactionCommitted = $true
    $finalFacts = Invoke-WindowsReleaseVerifier $releaseVerifierPath $finalOutputRoot $finalArchivePath $ReleaseName $distRoot
    [ordered]@{
        ok = $true
        release = $ReleaseName
        output = $finalOutputRoot
        archive = $finalArchivePath
        archive_bytes = [long]$finalFacts.archive_file.bytes
        archive_sha256 = [string]$finalFacts.archive_file.sha256
        node_version = $reportedNodeVersion
        webview2_offline_installer_bundled = $webView2InstallerBundled
        files = [int]$finalFacts.directory_file_count
        mapped_source_files = @($buildInputs.files | Where-Object { $null -ne $_.target }).Count
        build_inputs_sha256 = [string]$buildInputs.aggregate_sha256
    } | ConvertTo-Json -Depth 4
}
finally {
    Complete-ReleaseTransactionCleanup $transactionRoot $distRoot $transactionCommitted
}
