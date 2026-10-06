param([Parameter(Mandatory=$true)][string]$RequestFile, [Parameter(Mandatory=$true)][string]$ExpectedHash, [switch]$NoRestart, [switch]$ResumeCopy)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$request = $null
$lease = $null
$sourceWriter = $null
$targetWriter = $null
function FullPath([string]$value) {
    $full = [IO.Path]::GetFullPath($value).TrimEnd('\')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'A volume root is not a Cloudig folder.' }
    for ($cursor = $full; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (([IO.Directory]::Exists($cursor) -or [IO.File]::Exists($cursor)) -and (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'A move path is a link.' }
    }
    return $full
}
function WriteFailure([string]$root, [string]$message) {
    $directory = [IO.Path]::Combine($root, 'appdata', 'Move')
    if ([IO.Directory]::Exists($directory)) {
        $value = @{ schema='cloudig/library-move-result/1.0.0'; operation=$request.operation; status='failed'; message=$message; source=$request.sourceRoot; target=$request.targetRoot }
        [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'result.json'), ($value | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    }
}
try {
    $RequestFile = FullPath $RequestFile
    # Read+Delete sharing permits a same-volume root rename, but an explicit
    # cancellation's ReadWrite handle cannot enter while this helper is active.
    $lease = New-Object IO.FileStream($RequestFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($lease))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($actual -cne $ExpectedHash) { throw 'The frozen move request changed.' }
    $lease.Position = 0
    $reader = New-Object IO.StreamReader($lease, (New-Object Text.UTF8Encoding($false, $true)), $true, 4096, $true)
    try { $request = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($request.schema -cne 'cloudig/library-move/1.0.0' -or $null -eq $request.plan) { throw 'The move request is not ready.' }
    $source = FullPath $request.sourceRoot
    $target = FullPath $request.targetRoot
    if ($RequestFile -ine [IO.Path]::Combine($source, 'appdata', 'Move', 'request.json')) { throw 'The request is outside its source root.' }
    if ($target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $source -ieq $target) { throw 'Move roots overlap.' }
    if ($request.plan.sourceRoot -ine $source -or $request.plan.targetRoot -ine $target) { throw 'The frozen plan has different roots.' }
    foreach ($endpoint in @($request.sourceEndpoint, $request.targetEndpoint)) {
        if ($endpoint -cnotmatch '^\\\\\.\\pipe\\Cloudig-V1-Writer-[a-f0-9]{32}$') { throw 'Invalid move writer endpoint.' }
    }
    $sourceWriter = New-Object IO.Pipes.NamedPipeServerStream($request.sourceEndpoint.Substring(9), [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
    $targetWriter = New-Object IO.Pipes.NamedPipeServerStream($request.targetEndpoint.Substring(9), [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
    # A child handle can prevent renaming its parent on Windows even with
    # Delete sharing. Keep exclusion via the two writer pipes, not a disk lock.
    $lease.Dispose(); $lease = $null
    $deadline = [DateTime]::UtcNow.AddSeconds([int]$request.ownerExitTimeoutSeconds)
    while ($true) {
        $owner = Get-Process -Id ([int]$request.ownerPid) -ErrorAction SilentlyContinue
        if ($null -eq $owner) { break }
        try { if ($owner.StartTime.ToUniversalTime().Ticks.ToString() -cne [string]$request.ownerStarted) { break } } finally { $owner.Dispose() }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Cloudig has not exited; nothing was moved.' }
        Start-Sleep -Milliseconds ([int]$request.ownerExitPollMilliseconds)
    }
    if ([IO.File]::Exists($target)) { throw 'The target is a file.' }
    if ([IO.Directory]::Exists($target) -and @([IO.Directory]::EnumerateFileSystemEntries($target)).Count -ne 0) {
        if (-not $ResumeCopy -or $request.plan.strategy -cne 'copy_verify') { throw 'The target is no longer empty.' }
        $targetRequest = [IO.Path]::Combine($target, 'appdata', 'Move', 'request.json')
        $targetInput = [IO.File]::OpenRead($targetRequest); $hasher = [Security.Cryptography.SHA256]::Create()
        try { $targetHash = ([BitConverter]::ToString($hasher.ComputeHash($targetInput))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose(); $targetInput.Dispose() }
        if ($targetHash -cne $ExpectedHash) { throw 'The partial target is not this resumed move.' }
    }
    if ($request.plan.strategy -ceq 'rename') {
        $existed = [IO.Directory]::Exists($target)
        if ($existed) { [IO.Directory]::Delete($target, $false) }
        try { [IO.Directory]::Move($source, $target) }
        catch { if ($existed -and -not [IO.Directory]::Exists($target)) { [IO.Directory]::CreateDirectory($target) | Out-Null }; throw }
    } elseif ($request.plan.strategy -ceq 'copy_verify') {
        # No /MOVE, /MIR or /PURGE: the source is never deleted here. Skip every
        # pre-existing destination file; the app will reject any mismatch.
        & ([IO.Path]::Combine([Environment]::SystemDirectory, 'robocopy.exe')) $source $target /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /XJ /XC /XN /XO /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw ('Windows copy failed (' + $LASTEXITCODE + '); the source was preserved.') }
    } else { throw 'Unknown move strategy.' }
    $sourceWriter.Dispose(); $sourceWriter = $null
    $targetWriter.Dispose(); $targetWriter = $null
    if (-not $NoRestart) {
        Start-Process -FilePath ([IO.Path]::Combine($target, 'Cloudig.exe')) -WorkingDirectory $target -WindowStyle Hidden -ArgumentList @('--complete-library-move', [string]$request.operation, $ExpectedHash) | Out-Null
    }
    exit 0
} catch {
    $failureMessage = $_.Exception.Message
    if ($null -ne $lease) { $lease.Dispose(); $lease = $null }
    if ($null -ne $sourceWriter) { $sourceWriter.Dispose(); $sourceWriter = $null }
    if ($null -ne $targetWriter) { $targetWriter.Dispose(); $targetWriter = $null }
    if ($null -ne $request) {
        foreach ($root in @($request.sourceRoot, $request.targetRoot)) { try { WriteFailure (FullPath $root) $failureMessage } catch { } }
        if (-not $NoRestart) {
            foreach ($root in @($request.sourceRoot, $request.targetRoot)) {
                $entry = [IO.Path]::Combine($root, 'Cloudig.exe')
                if ([IO.File]::Exists($entry)) { Start-Process -FilePath $entry -WorkingDirectory $root -WindowStyle Hidden | Out-Null; break }
            }
        }
    }
    [Console]::Error.WriteLine($failureMessage)
    exit 1
} finally { if ($null -ne $lease) { $lease.Dispose() }; if ($null -ne $sourceWriter) { $sourceWriter.Dispose() }; if ($null -ne $targetWriter) { $targetWriter.Dispose() } }
