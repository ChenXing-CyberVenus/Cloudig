using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

public sealed record PortableMoveRequest(string Schema, string Operation, string SourceRoot, string TargetRoot,
    int OwnerPid, string OwnerStarted, string SourceEndpoint, string TargetEndpoint,
    int OwnerExitTimeoutSeconds, int OwnerExitPollMilliseconds, LibraryMovePlan? Plan);
public sealed record PreparedPortableMove(string RequestFile, string RequestSha256, PortableMoveRequest Request, bool ResumeCopy = false);
public sealed record PortableMoveResult(string Schema, string Operation, string Status, string Source, string Target, string? Message = null);
public sealed record PortableMovePreview(string SourceRoot, string TargetRoot, long TotalBytes, int TotalFiles, int TotalDirectories);

public static class PortableLibraryMove
{
    public const string RequestRelativePath = "appdata/Move/request.json";
    private const string Schema = "cloudig/library-move/1.0.0";
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = false };
    public static string RequestPath(string root) => Path.Combine(root, RequestRelativePath);
    public static bool IsPending(string root) => File.Exists(RequestPath(root));

    public static Task<PortableMovePreview> PreviewAsync(string sourceRoot, string targetRoot, CancellationToken cancellationToken = default) => Task.Run(() =>
    {
        var source = PlainRoot(sourceRoot); var target = PlainRoot(targetRoot); ValidatePair(source, target);
        RequireProgram(source); RequireSingleInstance(source);
        if (IsPending(source)) throw new IOException("A whole-root move is already pending.");
        if (!Directory.Exists(target) || Directory.EnumerateFileSystemEntries(target).Any()) throw new InvalidDataException("Choose an empty ordinary target directory.");
        long bytes = 0; int files = 0, directories = 0;
        var stack = new Stack<string>(); stack.Push(source);
        while (stack.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var entry in Directory.EnumerateFileSystemEntries(stack.Pop()))
            {
                var attributes = File.GetAttributes(entry); if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("A Cloudig move cannot follow links.");
                if (entry.Equals(Path.Combine(source, "cache"), StringComparison.OrdinalIgnoreCase)) continue;
                if ((attributes & FileAttributes.Directory) != 0) { directories++; stack.Push(entry); }
                else { bytes = checked(bytes + new FileInfo(entry).Length); if (++files > LibraryMoveLimits.MaximumFiles) throw new IOException("The move contains too many files."); }
            }
        }
        return new PortableMovePreview(source, target, bytes, files, directories);
    }, cancellationToken);

    public static async Task<PortableMoveRequest> BeginAsync(string sourceRoot, string targetRoot, string sourceEndpoint, string targetEndpoint, CancellationToken cancellationToken = default)
    {
        var source = PlainRoot(sourceRoot); var target = PlainRoot(targetRoot); ValidatePair(source, target);
        RequireProgram(source); RequireSingleInstance(source);
        if (!Directory.Exists(target) || Directory.EnumerateFileSystemEntries(target).Any()) throw new InvalidDataException("Choose an empty ordinary target directory.");
        using var sourceLease = Lease(sourceEndpoint); using var targetLease = Lease(targetEndpoint);
        if (IsPending(source)) throw new IOException("A whole-folder move is already pending.");
        // Both writers are excluded and no request has been published. A
        // preparation interrupted before publication has not moved anything;
        // retire only its two reserved scratch names before this explicit retry.
        ClearControlScratch(source);
        using var owner = Process.GetCurrentProcess();
        var request = new PortableMoveRequest(Schema, Guid.NewGuid().ToString("D"), source, target, owner.Id, owner.StartTime.ToUniversalTime().Ticks.ToString(), sourceEndpoint, targetEndpoint, LibraryMoveLimits.OwnerExitTimeoutSeconds, LibraryMoveLimits.OwnerExitPollMilliseconds, null);
        var file = RequestPath(source); PlainRoot(Path.GetDirectoryName(file)!); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await WriteAsync(file, request, cancellationToken, overwrite: false);
        return request;
    }

    public static void RequireSingleInstance(string root)
    {
        var entry = Path.Combine(root, "Cloudig.exe");
        foreach (var process in Process.GetProcessesByName("Cloudig"))
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;
                try { if (!process.HasExited && entry.Equals(process.MainModule?.FileName, StringComparison.OrdinalIgnoreCase)) throw new IOException("Please close other Cloudig windows from this folder before moving it."); }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception error) { throw new IOException("Cloudig could not verify that another program instance is closed.", error); }
            }
        }
    }

    // Called only after the initiating host has closed its Engine and WebView.
    // The request already blocks all new record reads/writes and cache sessions.
    public static async Task<PreparedPortableMove> FreezeAsync(PortableMoveRequest request, bool forceCopyForTests = false, CancellationToken cancellationToken = default)
    {
        var file = RequestPath(PlainRoot(request.SourceRoot));
        var stored = await ReadAsync(file, cancellationToken); if (stored != request || request.Plan is not null) throw new IOException("The pending move changed before shutdown completed.");
        RequireSingleInstance(request.SourceRoot);
        using var sourceLease = Lease(request.SourceEndpoint); using var targetLease = Lease(request.TargetEndpoint);
        ClearControlScratch(request.SourceRoot);
        var plan = await new LibraryMoveBoundary(forceCopyForTests).PlanAsync(request.SourceRoot, request.TargetRoot, cancellationToken: cancellationToken);
        var prepared = request with { Plan = plan };
        await WriteAsync(file, prepared, cancellationToken);
        return new PreparedPortableMove(file, Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(file, cancellationToken))).ToLowerInvariant(), prepared);
    }

    public static ProcessStartInfo HelperStartInfo(PreparedPortableMove prepared, bool noRestartForTests = false)
    {
        using var stream = typeof(PortableLibraryMove).Assembly.GetManifestResourceStream("Cloudig.PortableLibraryMove.ps1") ?? throw new InvalidOperationException("The move helper is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var command = "& {\n" + reader.ReadToEnd() + "\n} -RequestFile '" + prepared.RequestFile.Replace("'", "''") + "' -ExpectedHash '" + prepared.RequestSha256 + "'" + (noRestartForTests ? " -NoRestart" : "") + (prepared.ResumeCopy ? " -ResumeCopy" : "");
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(prepared.Request.TargetRoot)! };
        start.Environment["PSModuleAnalysisCachePath"] = "NUL";
        start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-NonInteractive"); start.ArgumentList.Add("-EncodedCommand"); start.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(command)));
        return start;
    }

    public static async Task<PortableMoveResult> CompleteAsync(string currentRoot, string operation, string expectedRequestHash, CancellationToken cancellationToken = default, Action<LibraryMoveProgress>? progress = null)
    {
        var target = PlainRoot(currentRoot); var file = RequestPath(target);
        CheckControl(file);
        await using var control = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.Delete);
        if (!Convert.ToHexString(await SHA256.HashDataAsync(control, cancellationToken)).Equals(expectedRequestHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("The move request changed after preparation.");
        control.Position = 0; var request = await JsonSerializer.DeserializeAsync<PortableMoveRequest>(control, Json, cancellationToken) ?? throw new InvalidDataException("Missing move request.");
        Validate(request);
        if (request.Operation != operation || !SamePath(request.TargetRoot, target) || request.Plan is null) throw new InvalidDataException("This move does not target the running Cloudig root.");
        if (!OwnerExited(request)) throw new IOException("The original Cloudig process is still running.");
        using var sourceLease = Lease(request.SourceEndpoint); using var targetLease = Lease(request.TargetEndpoint);
        ClearControlScratch(target);
        var boundary = new LibraryMoveBoundary(); await boundary.VerifyAsync(target, request.Plan, cancellationToken);
        string? warning = null;
        if (request.Plan.Strategy == "copy_verify")
        {
            var prior = await ReadResultAsync(target, cancellationToken);
            var resumingCleanup = prior is not null && prior.Operation == operation && SamePath(prior.Source, request.SourceRoot) && SamePath(prior.Target, target) && prior.Status is "cleanup_pending" or "source_retained";
            var originalControl = RequestPath(request.SourceRoot);
            if (!resumingCleanup || File.Exists(originalControl))
            {
                CheckControl(originalControl);
                await using var original = new FileStream(originalControl, FileMode.Open, FileAccess.ReadWrite, FileShare.Delete);
                if (!Convert.ToHexString(await SHA256.HashDataAsync(original, cancellationToken)).Equals(expectedRequestHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("The original move was cancelled or changed; both folders were preserved.");
            }
            if (!resumingCleanup) await boundary.VerifyAsync(request.SourceRoot, request.Plan, cancellationToken);
            await WriteAsync(Path.Combine(target, "appdata/Move/result.json"), new PortableMoveResult("cloudig/library-move-result/1.0.0", operation, "cleanup_pending", request.SourceRoot, target), cancellationToken);
            try { await boundary.RetireVerifiedSourceAsync(new LibraryMoveInstallation(request.Plan, false, true), progress, cancellationToken, allowAlreadyRemoved: resumingCleanup); }
            catch (IOException error) { warning = error.Message; }
            catch (UnauthorizedAccessException error) { warning = error.Message; }
        }
        else if (request.Plan.Strategy != "rename" || Directory.Exists(request.SourceRoot) || File.Exists(request.SourceRoot)) throw new IOException("The source still exists after a same-volume move; both folders were preserved.");
        var result = new PortableMoveResult("cloudig/library-move-result/1.0.0", operation, warning is null ? "completed" : "source_retained", request.SourceRoot, target, warning);
        await WriteAsync(Path.Combine(target, "appdata/Move/result.json"), result, cancellationToken);
        File.Delete(file);
        return result;
    }

    public static async Task<PortableMoveResult?> ReadResultAsync(string root, CancellationToken cancellationToken = default)
    {
        var file = Path.Combine(PlainRoot(root), "appdata/Move/result.json"); if (!File.Exists(file)) return null;
        CheckControl(file);
        var result = JsonSerializer.Deserialize<PortableMoveResult>(await File.ReadAllBytesAsync(file, cancellationToken), Json);
        if (result?.Schema != "cloudig/library-move-result/1.0.0") throw new InvalidDataException("Unsupported move result.");
        return result;
    }

    public static async Task<PreparedPortableMove> ResumeFromSourceAsync(string currentRoot, string operation, CancellationToken cancellationToken = default)
    {
        var root = PlainRoot(currentRoot); var file = RequestPath(root); var old = await ReadAsync(file, cancellationToken);
        if (old.Operation != operation || !SamePath(old.SourceRoot, root) || !OwnerExited(old)) throw new IOException("This move cannot be resumed from this running location.");
        RequireProgram(root); RequireSingleInstance(root);
        using var sourceLease = Lease(old.SourceEndpoint); using var targetLease = Lease(old.TargetEndpoint);
        if (!SameRequest(old, await ReadAsync(file, cancellationToken))) throw new IOException("The pending move changed while waiting; choose again.");
        ClearControlScratch(root);
        var hasTargetFiles = Directory.Exists(old.TargetRoot) && Directory.EnumerateFileSystemEntries(old.TargetRoot).Any();
        var boundary = new LibraryMoveBoundary();
        if (hasTargetFiles)
        {
            if (old.Plan?.Strategy != "copy_verify") throw new IOException("The target is no longer empty; both folders were preserved.");
            var targetRequest = RequestPath(old.TargetRoot); CheckControl(targetRequest);
            ClearControlScratch(old.TargetRoot);
            var sourceRequestBytes = await File.ReadAllBytesAsync(file, cancellationToken);
            var targetRequestBytes = await File.ReadAllBytesAsync(targetRequest, cancellationToken);
            if (!sourceRequestBytes.SequenceEqual(targetRequestBytes)) throw new IOException("The target belongs to another or changed move; both folders were preserved.");
            await boundary.VerifyAsync(root, old.Plan, cancellationToken);
            await VerifyPartialTargetAsync(old.Plan, cancellationToken);
        }
        using var owner = Process.GetCurrentProcess();
        var prepared = old with { OwnerPid = owner.Id, OwnerStarted = owner.StartTime.ToUniversalTime().Ticks.ToString(), Plan = hasTargetFiles ? old.Plan : await boundary.PlanAsync(root, old.TargetRoot, cancellationToken: cancellationToken) };
        await WriteAsync(file, prepared, cancellationToken);
        if (hasTargetFiles)
        {
            try { await WriteAsync(RequestPath(old.TargetRoot), prepared, cancellationToken); }
            catch { await WriteAsync(file, old, CancellationToken.None); throw; }
        }
        return new PreparedPortableMove(file, await RequestHashAsync(root, cancellationToken), prepared, hasTargetFiles);
    }

    public static async Task<PortableMoveResult> CancelFromSourceAsync(string currentRoot, string operation, CancellationToken cancellationToken = default)
    {
        var root = PlainRoot(currentRoot); var file = RequestPath(root); var request = await ReadAsync(file, cancellationToken);
        if (request.Operation != operation || !SamePath(request.SourceRoot, root) || !OwnerExited(request)) throw new IOException("The move is still active or this is not its original location.");
        RequireProgram(root); using var sourceLease = Lease(request.SourceEndpoint); using var targetLease = Lease(request.TargetEndpoint);
        await using var guard = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.Delete);
        var current = await JsonSerializer.DeserializeAsync<PortableMoveRequest>(guard, Json, cancellationToken) ?? throw new InvalidDataException("Missing move request."); Validate(current);
        if (!SameRequest(request, current)) throw new IOException("The move changed while cancellation was waiting; nothing was cancelled.");
        ClearControlScratch(root);
        var result = new PortableMoveResult("cloudig/library-move-result/1.0.0", operation, "cancelled", root, request.TargetRoot, "No conversation or user file was deleted; any copied target files were preserved.");
        await WriteAsync(Path.Combine(root, "appdata/Move/result.json"), result, cancellationToken);
        File.Delete(file); return result;
    }

    public static async Task<string> RequestHashAsync(string root, CancellationToken cancellationToken = default)
    {
        var file = RequestPath(PlainRoot(root)); CheckControl(file);
        await using var input = File.OpenRead(file); return Convert.ToHexString(await SHA256.HashDataAsync(input, cancellationToken)).ToLowerInvariant();
    }

    private static async Task VerifyPartialTargetAsync(LibraryMovePlan plan, CancellationToken cancellationToken)
    {
        PlainRoot(plan.TargetRoot);
        var expectedFiles = plan.Files.ToDictionary(file => file.RelativePath, StringComparer.OrdinalIgnoreCase);
        var expectedDirectories = plan.Directories.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<string>(); stack.Push(plan.TargetRoot);
        while (stack.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var path in Directory.EnumerateFileSystemEntries(stack.Pop()))
            {
                var relative = Path.GetRelativePath(plan.TargetRoot, path).Replace('\\', '/'); var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("The partial target contains a link.");
                if ((attributes & FileAttributes.Directory) != 0) { if (!expectedDirectories.Contains(relative)) throw new IOException("The partial target contains another directory; it was preserved."); stack.Push(path); continue; }
                if (relative is "appdata/Move/request.json" or "appdata/Move/result.json") continue;
                if (!expectedFiles.TryGetValue(relative, out var expected)) throw new IOException("The partial target contains another file; it was preserved.");
                await using var input = File.OpenRead(path);
                if (input.Length != expected.Bytes || !Convert.ToHexString(await SHA256.HashDataAsync(input, cancellationToken)).Equals(expected.Sha256, StringComparison.OrdinalIgnoreCase)) throw new IOException("A partial target file is incomplete or changed. Keep it; cancel the move or clear the target explicitly before retrying.");
            }
        }
    }

    public static async Task<PortableMoveRequest> ReadAsync(string file, CancellationToken cancellationToken = default)
    {
        CheckControl(file);
        await using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        var request = await JsonSerializer.DeserializeAsync<PortableMoveRequest>(input, Json, cancellationToken) ?? throw new InvalidDataException("Missing move request."); Validate(request); return request;
    }
    public static bool OwnerExited(PortableMoveRequest request)
    {
        try { using var owner = Process.GetProcessById(request.OwnerPid); return owner.HasExited || owner.StartTime.ToUniversalTime().Ticks.ToString() != request.OwnerStarted; }
        catch (ArgumentException) { return true; }
        catch (InvalidOperationException) { return true; }
    }
    private static void Validate(PortableMoveRequest request)
    {
        if (request.Schema != Schema || !Guid.TryParse(request.Operation, out _) || request.OwnerPid <= 0 || !long.TryParse(request.OwnerStarted, out _)) throw new InvalidDataException("Unsupported move request.");
        ValidatePair(PlainRoot(request.SourceRoot), PlainRoot(request.TargetRoot));
        if (request.Plan is { } plan)
        {
            if (!SamePath(plan.SourceRoot, request.SourceRoot) || !SamePath(plan.TargetRoot, request.TargetRoot) || plan.Strategy is not ("rename" or "copy_verify")) throw new InvalidDataException("Move plan roots changed.");
            LibraryMoveBoundary.ValidatePlan(plan);
        }
    }
    private static NamedPipeServerStream Lease(string endpoint)
    {
        const string prefix = @"\\.\pipe\"; const string name = "Cloudig-V1-Writer-";
        if (!endpoint.StartsWith(prefix + name, StringComparison.Ordinal) || endpoint.Length != prefix.Length + name.Length + 32 || endpoint[(prefix.Length + name.Length)..].Any(c => !char.IsAsciiHexDigit(c))) throw new InvalidDataException("Invalid Library writer endpoint.");
        return new NamedPipeServerStream(endpoint[prefix.Length..], PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance);
    }
    private static string PlainRoot(string value)
    {
        if (!Path.IsPathFullyQualified(value)) throw new InvalidDataException("Move roots must be absolute.");
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        if (root == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(root)!)) throw new InvalidDataException("A volume root cannot be a Cloudig directory.");
        for (var current = new DirectoryInfo(root); current is not null; current = current.Parent)
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("A move root cannot pass through a link.");
        return root;
    }
    private static void ValidatePair(string source, string target)
    {
        if (source.Equals(target, StringComparison.OrdinalIgnoreCase) || source.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || target.StartsWith(source + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Move roots overlap.");
    }
    private static bool SamePath(string left, string right) => left.Equals(right, StringComparison.OrdinalIgnoreCase);
    private static bool SameRequest(PortableMoveRequest left, PortableMoveRequest right) => left.Operation == right.Operation && left.Schema == right.Schema &&
        SamePath(left.SourceRoot, right.SourceRoot) && SamePath(left.TargetRoot, right.TargetRoot) && left.OwnerPid == right.OwnerPid && left.OwnerStarted == right.OwnerStarted &&
        left.SourceEndpoint == right.SourceEndpoint && left.TargetEndpoint == right.TargetEndpoint && left.Plan?.ManifestSha256 == right.Plan?.ManifestSha256 && left.Plan?.Strategy == right.Plan?.Strategy;
    private static void RequireProgram(string root)
    {
        foreach (var relative in new[] { "Cloudig.exe", "app/Cloudig.dll", "CloudigLibrary.json" })
            if (!File.Exists(Path.Combine(root, relative))) throw new InvalidDataException("Only a complete portable Cloudig folder can be moved; an isolated test data directory is not the program root.");
    }
    private static async Task WriteAsync<T>(string file, T value, CancellationToken cancellationToken, bool overwrite = true)
    {
        PlainRoot(Path.GetDirectoryName(file)!);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var next = file + ".next";
        var created = false;
        try
        {
            await using (var stream = new FileStream(next, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { created = true; await JsonSerializer.SerializeAsync(stream, value, Json, cancellationToken); await stream.FlushAsync(cancellationToken); stream.Flush(true); }
            File.Move(next, file, overwrite);
        }
        finally { if (created && File.Exists(next)) File.Delete(next); }
    }
    private static void ClearControlScratch(string root)
    {
        // These two reserved staging files are subordinate to this explicitly
        // resumed/cancelled move (or its unpublished preparation), not user
        // content or its frozen source files. Callers hold both writer leases.
        foreach (var leaf in new[] { "request.json.next", "result.json.next" })
        {
            var file = Path.Combine(root, "appdata/Move", leaf);
            if (!File.Exists(file)) continue;
            CheckControl(file); File.Delete(file);
        }
    }
    private static void CheckControl(string file)
    {
        PlainRoot(Path.GetDirectoryName(file)!);
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("A move control file cannot be a link.");
    }
}
