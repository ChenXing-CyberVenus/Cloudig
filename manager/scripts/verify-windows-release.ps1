[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Directory,
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ReleaseName,
    [string]$Boundary = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-SafeReleaseName([string]$Value) {
    if ($Value -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Unsafe Windows release name: $Value"
    }
}

function Assert-ContainedPath([string]$Candidate, [string]$Parent, [string]$Label, [bool]$AllowEqual = $false) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($AllowEqual -and $resolvedCandidate -ceq $resolvedParent) { return }
    if (-not $resolvedCandidate.StartsWith($resolvedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escaped its allowed boundary: $resolvedCandidate"
    }
}

function Assert-NoReparseComponents([string]$Candidate, [string]$AllowedBoundary, [string]$Label) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedBoundary = [IO.Path]::GetFullPath($AllowedBoundary).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    Assert-ContainedPath $resolvedCandidate $resolvedBoundary $Label $true
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
            throw "$Label could not be traced to its allowed boundary: $resolvedBoundary"
        }
        $cursor = $parent
    }
}

function ConvertTo-NormalizedRelativePath([string]$Value, [string]$Label) {
    $normalized = $Value.Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith("/", [StringComparison]::Ordinal) -or
        $normalized -match '^[A-Za-z]:' -or
        $normalized.IndexOf([char]0) -ge 0) {
        throw "$Label is not a safe relative path: $Value"
    }
    $segments = @($normalized.Split("/"))
    if ($segments.Count -eq 0 -or $segments -contains "" -or $segments -contains "." -or $segments -contains "..") {
        throw "$Label contains an unsafe path segment: $Value"
    }
    return ($segments -join "/")
}

function Get-Sha256FromBytes([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-Sha256FromStream([IO.Stream]$Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-PlainDirectoryFiles([string]$Root) {
    $result = @{}
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Root)
    while ($pending.Count -gt 0) {
        $currentPath = $pending.Dequeue()
        $current = Get-Item -LiteralPath $currentPath -Force
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Windows release directory contains a reparse point or junction: $currentPath"
        }
        if (-not $current.PSIsContainer) { throw "Windows release tree contains a non-directory root: $currentPath" }
        foreach ($child in @(Get-ChildItem -LiteralPath $currentPath -Force)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Windows release directory contains a reparse point or junction: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Enqueue($child.FullName)
                continue
            }
            $relative = ($child.FullName.Substring($Root.Length) -replace '^[\\/]+', '').Replace("\", "/")
            $relative = ConvertTo-NormalizedRelativePath $relative "Windows release file"
            $key = $relative.ToLowerInvariant()
            if ($result.ContainsKey($key)) { throw "Windows release directory contains a case-insensitive duplicate path: $relative" }
            $result[$key] = [pscustomobject]@{
                path = $relative
                bytes = [long]$child.Length
                sha256 = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
    return $result
}

Assert-SafeReleaseName $ReleaseName
$resolvedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$resolvedArchive = [IO.Path]::GetFullPath($Archive)
if ([string]::IsNullOrWhiteSpace($Boundary)) {
    $Boundary = Split-Path -Parent $resolvedDirectory
}
$resolvedBoundary = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
Assert-NoReparseComponents $resolvedDirectory $resolvedBoundary "Windows release directory"
Assert-NoReparseComponents $resolvedArchive $resolvedBoundary "Windows release archive"
if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) { throw "Windows release directory is missing: $resolvedDirectory" }
if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) { throw "Windows release archive is missing: $resolvedArchive" }
$archiveItem = Get-Item -LiteralPath $resolvedArchive -Force
if (($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Windows release archive must be a plain file." }

$directoryFiles = Get-PlainDirectoryFiles $resolvedDirectory
$manifestKey = "release-manifest.json"
if (-not $directoryFiles.ContainsKey($manifestKey)) { throw "Windows release directory is missing release-manifest.json." }
$manifestPath = Join-Path $resolvedDirectory "release-manifest.json"
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "Windows release manifest is invalid JSON: $($_.Exception.Message)"
}
if ([string]$manifest.format -cne "cloudig/windows-release-manifest") { throw "Windows release manifest format drifted." }
if ([string]$manifest.release -cne $ReleaseName) { throw "Windows release manifest release name drifted." }
if ($manifest.PSObject.Properties["files"] -eq $null -or $manifest.files -isnot [Array]) {
    throw "Windows release manifest files must be an array."
}

$declaredFiles = @{}
foreach ($declared in @($manifest.files)) {
    $relative = ConvertTo-NormalizedRelativePath ([string]$declared.path) "Windows release manifest path"
    if ($relative -ceq "release-manifest.json") { throw "Windows release manifest must not declare itself." }
    $key = $relative.ToLowerInvariant()
    if ($declaredFiles.ContainsKey($key)) { throw "Windows release manifest contains a case-insensitive duplicate path: $relative" }
    $bytes = [long]$declared.bytes
    $digest = [string]$declared.sha256
    if ($bytes -lt 0 -or $digest -cnotmatch '^[0-9a-f]{64}$') { throw "Windows release manifest metadata is invalid: $relative" }
    if (-not $directoryFiles.ContainsKey($key)) { throw "Windows release manifest declares a missing file: $relative" }
    $actual = $directoryFiles[$key]
    if ($actual.path -cne $relative) { throw "Windows release path casing drifted: $relative" }
    if ($actual.bytes -ne $bytes) { throw "Windows release file byte count drifted: $relative" }
    if ($actual.sha256 -cne $digest) { throw "Windows release file SHA-256 drifted: $relative" }
    $declaredFiles[$key] = $actual
}
if ($directoryFiles.Count -ne $declaredFiles.Count + 1) {
    $unexpected = @($directoryFiles.Values | Where-Object { $_.path -cne "release-manifest.json" -and -not $declaredFiles.ContainsKey($_.path.ToLowerInvariant()) } | ForEach-Object { $_.path })
    throw "Windows release directory contains files absent from the manifest: $($unexpected -join ', ')"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($resolvedArchive)
try {
    $seenEntries = @{}
    $zipFiles = @{}
    foreach ($entry in $zip.Entries) {
        $raw = ([string]$entry.FullName).Replace("\", "/")
        $isDirectory = $raw.EndsWith("/", [StringComparison]::Ordinal)
        $withoutTrailingSlash = if ($isDirectory) { $raw.TrimEnd("/") } else { $raw }
        $safe = ConvertTo-NormalizedRelativePath $withoutTrailingSlash "Windows release ZIP entry"
        $entryKey = ($safe + $(if ($isDirectory) { "/" } else { "" })).ToLowerInvariant()
        if ($seenEntries.ContainsKey($entryKey)) { throw "Windows release ZIP contains a duplicate entry: $raw" }
        $seenEntries[$entryKey] = $true
        $segments = @($safe.Split("/"))
        if ($segments[0] -cne $ReleaseName) { throw "Windows release ZIP entry escaped its unique release root: $raw" }
        if ($segments.Count -eq 1) {
            if (-not $isDirectory) { throw "Windows release ZIP root must be a directory: $raw" }
            continue
        }
        if ($isDirectory) { continue }
        $relative = ($segments[1..($segments.Count - 1)] -join "/")
        $key = $relative.ToLowerInvariant()
        if ($zipFiles.ContainsKey($key)) { throw "Windows release ZIP contains a case-insensitive duplicate file: $relative" }
        $stream = $entry.Open()
        try {
            $zipFiles[$key] = [pscustomobject]@{
                path = $relative
                bytes = [long]$entry.Length
                sha256 = Get-Sha256FromStream $stream
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    if ($zipFiles.Count -ne $directoryFiles.Count) { throw "Windows release ZIP file set differs from the release directory." }
    foreach ($directoryFile in $directoryFiles.Values) {
        $key = $directoryFile.path.ToLowerInvariant()
        if (-not $zipFiles.ContainsKey($key)) { throw "Windows release ZIP is missing: $($directoryFile.path)" }
        $zipFile = $zipFiles[$key]
        if ($zipFile.path -cne $directoryFile.path -or $zipFile.bytes -ne $directoryFile.bytes -or $zipFile.sha256 -cne $directoryFile.sha256) {
            throw "Windows release ZIP entry differs from the release directory: $($directoryFile.path)"
        }
    }
}
finally {
    $zip.Dispose()
}

[ordered]@{
    ok = $true
    release = $ReleaseName
    payload_count = $declaredFiles.Count
    directory_file_count = $directoryFiles.Count
    manifest_file = $directoryFiles[$manifestKey]
    archive_file = [ordered]@{
        path = [IO.Path]::GetFileName($resolvedArchive)
        bytes = [long]$archiveItem.Length
        sha256 = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    }
} | ConvertTo-Json -Depth 5 -Compress
