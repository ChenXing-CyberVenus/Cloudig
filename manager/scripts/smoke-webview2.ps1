[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [string]$NodeExecutable = "",
    [ValidateRange(5, 60)]
    [int]$TimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$nativeSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CloudigProcessSnapshot
{
    public int ProcessId { get; set; }
    public int ParentProcessId { get; set; }
    public string Name { get; set; }
    public string ExecutablePath { get; set; }
    public long CreationFileTimeUtc { get; set; }
}

public sealed class CloudigSmokeJob : IDisposable
{
    private IntPtr jobHandle;
    private IntPtr processHandle;
    private bool closed;

    internal CloudigSmokeJob(IntPtr jobHandle, IntPtr processHandle, int processId)
    {
        this.jobHandle = jobHandle;
        this.processHandle = processHandle;
        ProcessId = processId;
    }

    public int ProcessId { get; private set; }

    public bool IsRootAlive()
    {
        if (processHandle == IntPtr.Zero) return false;
        return CloudigSmokeNative.WaitForSingleObject(processHandle, 0) == CloudigSmokeNative.WAIT_TIMEOUT;
    }

    public void TerminateAndClose(int waitMilliseconds)
    {
        if (closed) return;
        closed = true;
        Exception closeFailure = null;
        if (jobHandle != IntPtr.Zero)
        {
            if (!CloudigSmokeNative.CloseHandle(jobHandle))
            {
                closeFailure = new Win32Exception(Marshal.GetLastWin32Error(), "Could not close the Cloudig smoke Job Object.");
            }
            jobHandle = IntPtr.Zero;
        }
        uint waitResult = CloudigSmokeNative.WAIT_OBJECT_0;
        if (processHandle != IntPtr.Zero)
        {
            waitResult = CloudigSmokeNative.WaitForSingleObject(processHandle, (uint)Math.Max(0, waitMilliseconds));
            CloudigSmokeNative.CloseHandle(processHandle);
            processHandle = IntPtr.Zero;
        }
        if (closeFailure != null) throw closeFailure;
        if (waitResult != CloudigSmokeNative.WAIT_OBJECT_0)
        {
            throw new InvalidOperationException("Cloudig smoke root did not exit after closing its KILL_ON_JOB_CLOSE Job Object.");
        }
    }

    public void Dispose()
    {
        if (!closed) TerminateAndClose(5000);
    }
}

public static class CloudigSmokeNative
{
    internal const uint WAIT_OBJECT_0 = 0;
    internal const uint WAIT_TIMEOUT = 258;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref int lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr hObject);

    public static CloudigProcessSnapshot[] CaptureProcesses()
    {
        List<CloudigProcessSnapshot> result = new List<CloudigProcessSnapshot>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateToolhelp32Snapshot failed.");
        }
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Process32First failed.");
            }
            do
            {
                string executablePath = String.Empty;
                long creationFileTimeUtc = 0;
                IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID);
                if (process != IntPtr.Zero)
                {
                    try
                    {
                        StringBuilder path = new StringBuilder(32768);
                        int pathLength = path.Capacity;
                        if (QueryFullProcessImageNameW(process, 0, path, ref pathLength)) executablePath = path.ToString();
                        FILETIME creation;
                        FILETIME exit;
                        FILETIME kernel;
                        FILETIME user;
                        if (GetProcessTimes(process, out creation, out exit, out kernel, out user))
                        {
                            creationFileTimeUtc = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
                        }
                    }
                    finally
                    {
                        CloseHandle(process);
                    }
                }
                result.Add(new CloudigProcessSnapshot
                {
                    ProcessId = unchecked((int)entry.th32ProcessID),
                    ParentProcessId = unchecked((int)entry.th32ParentProcessID),
                    Name = entry.szExeFile ?? String.Empty,
                    ExecutablePath = executablePath,
                    CreationFileTimeUtc = creationFileTimeUtc
                });
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return result.ToArray();
    }

    public static CloudigSmokeJob StartInKillOnCloseJob(string executable, string arguments, string workingDirectory, IDictionary environmentOverrides)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "Could not enable KILL_ON_JOB_CLOSE for the Cloudig smoke Job Object.");
        }

        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            SortedDictionary<string, string> selectedEnvironment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry item in Environment.GetEnvironmentVariables())
            {
                string key = item.Key as string;
                if (!String.IsNullOrEmpty(key)) selectedEnvironment[key] = Convert.ToString(item.Value) ?? String.Empty;
            }
            if (environmentOverrides != null)
            {
                foreach (DictionaryEntry item in environmentOverrides)
                {
                    string key = item.Key as string;
                    if (String.IsNullOrEmpty(key)) continue;
                    if (item.Value == null) selectedEnvironment.Remove(key);
                    else selectedEnvironment[key] = Convert.ToString(item.Value) ?? String.Empty;
                }
            }
            StringBuilder environmentBlock = new StringBuilder();
            foreach (KeyValuePair<string, string> item in selectedEnvironment)
            {
                environmentBlock.Append(item.Key).Append('=').Append(item.Value).Append('\0');
            }
            environmentBlock.Append('\0');
            environment = Marshal.StringToHGlobalUni(environmentBlock.ToString());

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESHOWWINDOW;
            startup.wShowWindow = SW_HIDE;
            StringBuilder commandLine = new StringBuilder();
            commandLine.Append('"').Append(executable.Replace("\"", "\\\"")).Append('"');
            if (!String.IsNullOrWhiteSpace(arguments)) commandLine.Append(' ').Append(arguments);
            uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
            if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, environment, workingDirectory, ref startup, out processInfo))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the Cloudig smoke process.");
            }
            processCreated = true;
            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign the suspended Cloudig process to its exact Job Object.");
            }
            uint resumeResult = ResumeThread(processInfo.hThread);
            if (resumeResult == UInt32.MaxValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume the Job-bound Cloudig smoke process.");
            }
            CloseHandle(processInfo.hThread);
            processInfo.hThread = IntPtr.Zero;
            return new CloudigSmokeJob(job, processInfo.hProcess, unchecked((int)processInfo.dwProcessId));
        }
        catch
        {
            if (processCreated && processInfo.hProcess != IntPtr.Zero) TerminateProcess(processInfo.hProcess, 0xC10D);
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            CloseHandle(job);
            throw;
        }
        finally
        {
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null

function Assert-ChildPath([string]$Candidate, [string]$Parent, [string]$Label) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $resolvedCandidate.StartsWith($resolvedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escaped its allowed directory: $resolvedCandidate"
    }
}

function Assert-NoReparseComponents([string]$Candidate, [string]$Boundary, [string]$Label) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedBoundary = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolvedCandidate -ine $resolvedBoundary) { Assert-ChildPath $resolvedCandidate $resolvedBoundary $Label }
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
        foreach ($child in @(Get-ChildItem -LiteralPath $currentPath -Force)) { $pending.Enqueue($child.FullName) }
    }
}

function Get-NativeProcessSnapshot {
    return @([CloudigSmokeNative]::CaptureProcesses())
}

function Get-ProcessSnapshotById([int]$ProcessId, [object[]]$AllProcesses) {
    $matches = @($AllProcesses | Where-Object { [int]$_.ProcessId -eq $ProcessId })
    if ($matches.Count -eq 0) { return $null }
    if ($matches.Count -ne 1) { throw "Toolhelp returned multiple process snapshots for PID $ProcessId." }
    return $matches[0]
}

function Assert-ProcessSnapshotIdentity([object]$Expected, [object]$Current) {
    if ($null -eq $Expected -or $null -eq $Current) { throw "A Cloudig process identity snapshot is missing." }
    $expectedPath = [string]$Expected.ExecutablePath
    $currentPath = [string]$Current.ExecutablePath
    $expectedCreation = [long]$Expected.CreationFileTimeUtc
    $currentCreation = [long]$Current.CreationFileTimeUtc
    if ([string]::IsNullOrWhiteSpace($expectedPath) -or [string]::IsNullOrWhiteSpace($currentPath)) {
        throw "Cloudig root executable path cannot be confirmed."
    }
    if ($expectedCreation -le 0 -or $currentCreation -le 0) { throw "Cloudig root creation time cannot be confirmed." }
    $matches = [int]$Expected.ProcessId -eq [int]$Current.ProcessId -and
        [int]$Expected.ParentProcessId -eq [int]$Current.ParentProcessId -and
        ([string]$Expected.Name -ieq [string]$Current.Name) -and
        $expectedCreation -eq $currentCreation -and
        ([IO.Path]::GetFullPath($expectedPath) -ieq [IO.Path]::GetFullPath($currentPath))
    if (-not $matches) { throw "Cloudig root PID, parent, name, creation time or executable path changed." }
}

function Get-DescendantProcesses([object]$RootSnapshot, [object[]]$AllProcesses) {
    $known = [Collections.Generic.HashSet[int]]::new()
    [void]$known.Add([int]$RootSnapshot.ProcessId)
    $result = [Collections.Generic.List[object]]::new()
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($candidate in $AllProcesses) {
            $pidValue = [int]$candidate.ProcessId
            if ($known.Contains($pidValue) -or -not $known.Contains([int]$candidate.ParentProcessId)) { continue }
            if ([long]$candidate.CreationFileTimeUtc -le [long]$RootSnapshot.CreationFileTimeUtc) { continue }
            [void]$known.Add($pidValue)
            $result.Add($candidate)
            $changed = $true
        }
    }
    return @($result)
}

function Get-StableWebViewSignature([object[]]$Processes) {
    $identities = @()
    foreach ($candidate in @($Processes | Where-Object { $_.Name -ieq "msedgewebview2.exe" })) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath) -or [long]$candidate.CreationFileTimeUtc -le 0) {
            throw "A WebView2 descendant path or creation time cannot be confirmed."
        }
        $resolvedPath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
        if ([IO.Path]::GetFileName($resolvedPath) -ine "msedgewebview2.exe" -or -not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
            throw "A claimed WebView2 descendant executable cannot be verified: $resolvedPath"
        }
        $identities += ("{0}|{1}|{2}" -f [int]$candidate.ProcessId, [long]$candidate.CreationFileTimeUtc, $resolvedPath.ToLowerInvariant())
    }
    return (@($identities | Sort-Object) -join "`n")
}

$resolvedExecutable = [IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) { throw "Cloudig smoke executable does not exist: $resolvedExecutable" }
if (-not [string]::IsNullOrWhiteSpace($NodeExecutable)) {
    $NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw "Cloudig smoke Node executable does not exist: $NodeExecutable" }
}

$systemTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$smokeRoot = Join-Path $systemTemporaryRoot ("Cloudig-WebView2-Smoke-" + [Guid]::NewGuid().ToString("N"))
if (-not ([IO.Path]::GetFullPath($smokeRoot).StartsWith($systemTemporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Cloudig smoke root escaped the Windows temporary directory."
}

$job = $null
$rootProcessSnapshot = $null
$startedAt = [DateTimeOffset]::UtcNow
$stableWebViewProcesses = @()
$stableSignature = ""
$stableSamples = 0
$primaryError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$result = $null
try {
    Assert-NoReparseComponents $smokeRoot $systemTemporaryRoot "Cloudig smoke root"
    New-Item -ItemType Directory -Path $smokeRoot | Out-Null
    Assert-NoReparseComponents $smokeRoot $systemTemporaryRoot "Cloudig smoke root"
    $environmentOverrides = @{
        CLOUDIG_SMOKE_LOCAL_DATA_ROOT = $smokeRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($NodeExecutable)) { $environmentOverrides.CLOUDIG_NODE = $NodeExecutable }
    $job = [CloudigSmokeNative]::StartInKillOnCloseJob(
        $resolvedExecutable,
        "",
        (Split-Path -Parent $resolvedExecutable),
        $environmentOverrides)

    $identityDeadline = [DateTimeOffset]::UtcNow.AddSeconds(3)
    while ($null -eq $rootProcessSnapshot -and [DateTimeOffset]::UtcNow -lt $identityDeadline) {
        $allProcesses = @(Get-NativeProcessSnapshot)
        $candidateRoot = Get-ProcessSnapshotById $job.ProcessId $allProcesses
        if ($null -ne $candidateRoot -and
            -not [string]::IsNullOrWhiteSpace([string]$candidateRoot.ExecutablePath) -and
            [long]$candidateRoot.CreationFileTimeUtc -gt 0) {
            $rootProcessSnapshot = $candidateRoot
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if ($null -eq $rootProcessSnapshot) { throw "Toolhelp could not confirm the Cloudig smoke root identity." }
    if ([IO.Path]::GetFullPath([string]$rootProcessSnapshot.ExecutablePath) -ine $resolvedExecutable) {
        throw "The Cloudig smoke root process path could not be confirmed."
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if (-not $job.IsRootAlive()) { throw "Cloudig exited during WebView2 smoke." }
        $allProcesses = @(Get-NativeProcessSnapshot)
        $currentRootSnapshot = Get-ProcessSnapshotById $job.ProcessId $allProcesses
        Assert-ProcessSnapshotIdentity $rootProcessSnapshot $currentRootSnapshot
        $descendants = @(Get-DescendantProcesses $rootProcessSnapshot $allProcesses)
        $currentSignature = Get-StableWebViewSignature $descendants
        if (-not [string]::IsNullOrWhiteSpace($currentSignature)) {
            if ($currentSignature -ceq $stableSignature) { $stableSamples += 1 }
            else {
                $stableSignature = $currentSignature
                $stableSamples = 1
            }
            $stableWebViewProcesses = @($descendants | Where-Object { $_.Name -ieq "msedgewebview2.exe" })
            if ($stableSamples -ge 2) { break }
        }
        else {
            $stableSignature = ""
            $stableSamples = 0
            $stableWebViewProcesses = @()
        }
    }
    if (-not $job.IsRootAlive() -or $stableWebViewProcesses.Count -eq 0 -or $stableSamples -lt 2) {
        throw "Cloudig stayed alive but did not create a stable, path-verified WebView2 Runtime process subtree."
    }
    $runtimePath = @($stableWebViewProcesses | Sort-Object ProcessId | Select-Object -First 1).ExecutablePath
    $runtimeVersion = (Get-Item -LiteralPath $runtimePath -Force).VersionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace([string]$runtimeVersion)) { throw "The stable WebView2 Runtime version could not be read." }
    $result = [ordered]@{
        ok = $true
        executable = $resolvedExecutable
        main_process_alive = $true
        process_enumerator = "Toolhelp32"
        job_kill_on_close = $true
        webview2_process_count = $stableWebViewProcesses.Count
        webview2_runtime_path = [IO.Path]::GetFullPath([string]$runtimePath)
        webview2_runtime_version = [string]$runtimeVersion
        local_data_isolated = [IO.Path]::GetFullPath($smokeRoot).StartsWith($systemTemporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        elapsed_ms = [int]([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds
    }
}
catch {
    $primaryError = $_.Exception
}
finally {
    $jobCleanupSucceeded = $true
    if ($null -ne $job) {
        try {
            $job.TerminateAndClose(5000)
        }
        catch {
            $jobCleanupSucceeded = $false
            $cleanupErrors.Add("Job cleanup failed: $($_.Exception.Message)")
        }
    }
    if ($jobCleanupSucceeded -and (Test-Path -LiteralPath $smokeRoot)) {
        try {
            $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot)
            if (-not $resolvedSmokeRoot.StartsWith($systemTemporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove a Cloudig smoke directory outside Windows temporary storage."
            }
            Assert-NoReparseComponents $resolvedSmokeRoot $systemTemporaryRoot "Cloudig smoke cleanup root"
            for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
                Assert-NoReparseTree $resolvedSmokeRoot "Cloudig smoke cleanup tree"
                try {
                    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
                    break
                }
                catch {
                    if ($attempt -eq 19) { throw }
                    Start-Sleep -Milliseconds 350
                }
            }
            if (Test-Path -LiteralPath $resolvedSmokeRoot) { throw "Cloudig smoke diagnostic root remained after cleanup retries." }
        }
        catch {
            $cleanupErrors.Add("Temporary-root cleanup failed and diagnostics were preserved at ${smokeRoot}: $($_.Exception.Message)")
        }
    }
    elseif (-not $jobCleanupSucceeded -and (Test-Path -LiteralPath $smokeRoot)) {
        $cleanupErrors.Add("Diagnostics were preserved because exact Job cleanup was not confirmed: $smokeRoot")
    }
}

if ($null -ne $primaryError -or $cleanupErrors.Count -gt 0) {
    $messages = @()
    if ($null -ne $primaryError) { $messages += "Smoke failed: $($primaryError.Message)" }
    $messages += @($cleanupErrors)
    throw ($messages -join " ")
}

$result | ConvertTo-Json -Depth 4
