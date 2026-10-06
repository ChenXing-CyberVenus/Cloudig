using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Cloudig.Desktop.Core;

public sealed record LibraryMoveProgress(string Phase, long CompletedBytes, long TotalBytes, int CompletedFiles, int TotalFiles);
public sealed record LibraryMoveFile(
    string RelativePath,
    long Bytes,
    string Sha256,
    long CreationTimeUtcTicks,
    long LastWriteTimeUtcTicks,
    int Attributes);
public sealed record LibraryMovePlan(
    string SourceRoot,
    string TargetRoot,
    string Strategy,
    bool TargetExisted,
    string ManifestSha256,
    long TotalBytes,
    int TotalFiles,
    int TotalDirectories,
    IReadOnlyList<string> Directories,
    IReadOnlyList<LibraryMoveFile> Files);
public sealed record LibraryMoveInstallation(LibraryMovePlan Plan, bool SourceMoved, bool TargetPublished);

public sealed class LibraryMoveCapabilityException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

public sealed class LibraryMoveBoundary(bool forceCopyForTests = false)
{
    private static int BufferBytes => LibraryMoveLimits.BufferBytes;

    public async Task<LibraryMovePlan> PlanAsync(
        string sourceRoot,
        string targetRoot,
        Action<LibraryMoveProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var source = NormalizeRoot(sourceRoot);
        var target = NormalizeRoot(targetRoot);
        ValidatePair(source, target);
        RequireLibraryShape(source);
        var targetExisted = ValidateEmptyTarget(target);
        var fingerprint = await FingerprintAsync(source, "plan", progress, cancellationToken);
        var sameVolume = Path.GetPathRoot(source)!.Equals(Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase);
        var strategy = sameVolume && !forceCopyForTests ? "rename" : "copy_verify";
        if (strategy == "copy_verify") RequireCapacity(target, fingerprint.TotalBytes);
        return new LibraryMovePlan(
            source,
            target,
            strategy,
            targetExisted,
            fingerprint.ManifestSha256,
            fingerprint.TotalBytes,
            fingerprint.Files.Count,
            fingerprint.Directories.Count,
            fingerprint.Directories,
            fingerprint.Files);
    }

    public async Task<LibraryMoveInstallation> PrepareTargetAsync(
        LibraryMovePlan plan,
        Action<LibraryMoveProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ValidatePair(plan.SourceRoot, plan.TargetRoot);
        ValidateEmptyTarget(plan.TargetRoot, plan.TargetExisted);
        await RequireFingerprintAsync(plan.SourceRoot, plan, "source-verify", progress, cancellationToken);
        if (plan.Strategy == "rename")
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (plan.TargetExisted) Directory.Delete(plan.TargetRoot, false);
            try
            {
                Directory.Move(plan.SourceRoot, plan.TargetRoot);
                await RequireFingerprintAsync(plan.TargetRoot, plan, "target-verify", progress, cancellationToken);
                return new LibraryMoveInstallation(plan, true, true);
            }
            catch
            {
                if (!Directory.Exists(plan.SourceRoot) && Directory.Exists(plan.TargetRoot)) Directory.Move(plan.TargetRoot, plan.SourceRoot);
                if (plan.TargetExisted && !Directory.Exists(plan.TargetRoot)) Directory.CreateDirectory(plan.TargetRoot);
                throw;
            }
        }

        if (plan.Strategy != "copy_verify") throw new InvalidDataException("Cloudig Library move strategy is invalid.");
        var staging = $"{plan.TargetRoot}.cloudig-move-{Guid.NewGuid():N}";
        if (Directory.Exists(staging) || File.Exists(staging)) throw new IOException("Cloudig Library move staging path already exists.");
        var targetPublished = false;
        try
        {
            Directory.CreateDirectory(staging);
            foreach (var directory in plan.Directories.OrderBy(value => value.Count(character => character == '/')).ThenBy(value => value, StringComparer.Ordinal))
            {
                Directory.CreateDirectory(ResolveRelative(staging, directory));
            }
            long completedBytes = 0;
            var completedFiles = 0;
            foreach (var file in plan.Files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var source = ResolveRelative(plan.SourceRoot, file.RelativePath);
                var destination = ResolveRelative(staging, file.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                var copiedHash = await CopyAndHashAsync(source, destination, value =>
                {
                    progress?.Invoke(new LibraryMoveProgress("copy", completedBytes + value, plan.TotalBytes, completedFiles, plan.TotalFiles));
                }, cancellationToken);
                if (copiedHash.Bytes != file.Bytes || !FixedHashEquals(copiedHash.Sha256, file.Sha256))
                {
                    throw new IOException($"Cloudig Library copy verification failed: {file.RelativePath}");
                }
                File.SetCreationTimeUtc(destination, new DateTime(file.CreationTimeUtcTicks, DateTimeKind.Utc));
                File.SetLastWriteTimeUtc(destination, new DateTime(file.LastWriteTimeUtcTicks, DateTimeKind.Utc));
                File.SetAttributes(destination, (FileAttributes)file.Attributes);
                completedBytes += file.Bytes;
                completedFiles += 1;
                progress?.Invoke(new LibraryMoveProgress("copy", completedBytes, plan.TotalBytes, completedFiles, plan.TotalFiles));
            }
            await RequireFingerprintAsync(staging, plan, "target-verify", progress, cancellationToken);
            await RequireFingerprintAsync(plan.SourceRoot, plan, "source-final", progress, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            ValidateEmptyTarget(plan.TargetRoot, plan.TargetExisted);
            if (plan.TargetExisted) Directory.Delete(plan.TargetRoot, false);
            Directory.Move(staging, plan.TargetRoot);
            targetPublished = true;
            return new LibraryMoveInstallation(plan, false, true);
        }
        catch
        {
            if (!targetPublished && Directory.Exists(staging)) Directory.Delete(staging, true);
            if (plan.TargetExisted && !Directory.Exists(plan.TargetRoot)) Directory.CreateDirectory(plan.TargetRoot);
            throw;
        }
    }

    public async Task CompleteSourceCleanupAsync(
        LibraryMoveInstallation installation,
        Action<LibraryMoveProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (installation.SourceMoved) return;
        await RequireFingerprintAsync(installation.Plan.TargetRoot, installation.Plan, "cleanup-verify-target", progress, cancellationToken);
        await RequireFingerprintAsync(installation.Plan.SourceRoot, installation.Plan, "cleanup-verify-source", progress, cancellationToken);
        await RetireVerifiedSourceAsync(installation, progress, cancellationToken);
    }

    // The post-exit caller has already verified both complete trees under the
    // two writer leases. Do not read both entire Libraries a second time.
    internal async Task RetireVerifiedSourceAsync(LibraryMoveInstallation installation, Action<LibraryMoveProgress>? progress = null, CancellationToken cancellationToken = default, bool allowAlreadyRemoved = false)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long retiredBytes = 0; var retiredFiles = 0;
        progress?.Invoke(new LibraryMoveProgress("cleanup", 0, installation.Plan.TotalBytes, 0, installation.Plan.TotalFiles));
        // Retire only the frozen, verified file set. A newly arrived file must
        // stop empty-directory removal, never disappear in a recursive delete.
        foreach (var file in installation.Plan.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var source = ResolveRelative(installation.Plan.SourceRoot, file.RelativePath);
            if (allowAlreadyRemoved && !File.Exists(source) && !Directory.Exists(source)) { retiredBytes += file.Bytes; retiredFiles++; continue; }
            ValidateAncestors(Path.GetDirectoryName(source)!);
            var current = await HashFileAsync(source, null, cancellationToken);
            if (current.Bytes != file.Bytes || !FixedHashEquals(current.Sha256, file.Sha256)) throw new IOException("An original changed during source cleanup; remaining files were preserved.");
            var attributes = File.GetAttributes(source);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("A source path became a link.");
            ValidateAncestors(Path.GetDirectoryName(source)!);
            if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(source, attributes & ~FileAttributes.ReadOnly);
            File.Delete(source);
            retiredBytes += file.Bytes; retiredFiles++;
            progress?.Invoke(new LibraryMoveProgress("cleanup", retiredBytes, installation.Plan.TotalBytes, retiredFiles, installation.Plan.TotalFiles));
        }
        foreach (var control in new[] { "appdata/Move/request.json", "appdata/Move/result.json" })
        {
            var file = ResolveRelative(installation.Plan.SourceRoot, control);
            if (File.Exists(file)) File.Delete(file);
        }
        foreach (var directory in installation.Plan.Directories.OrderByDescending(value => value.Count(character => character == '/')))
        {
            var target = ResolveRelative(installation.Plan.SourceRoot, directory);
            if (allowAlreadyRemoved && !Directory.Exists(target) && !File.Exists(target)) continue;
            ValidateAncestors(target); RequireNotReparse(target); Directory.Delete(target, false);
        }
        if (Directory.Exists(installation.Plan.SourceRoot)) Directory.Delete(installation.Plan.SourceRoot, false);
        else if (File.Exists(installation.Plan.SourceRoot)) throw new IOException("The source directory was replaced by a file.");
        if (Directory.Exists(installation.Plan.SourceRoot)) throw new IOException("Cloudig Library source cleanup did not complete.");
    }

    public Task VerifyAsync(string root, LibraryMovePlan plan, CancellationToken cancellationToken = default) =>
        RequireFingerprintAsync(root, plan, "verify", null, cancellationToken);

    public async Task RollbackAsync(LibraryMoveInstallation installation, CancellationToken cancellationToken = default)
    {
        var plan = installation.Plan;
        if (!installation.TargetPublished) return;
        if (installation.SourceMoved)
        {
            await RequireFingerprintAsync(plan.TargetRoot, plan, "rollback-verify", null, cancellationToken);
            if (Directory.Exists(plan.SourceRoot) || File.Exists(plan.SourceRoot)) throw new IOException("Cloudig Library rollback source path is occupied.");
            Directory.Move(plan.TargetRoot, plan.SourceRoot);
            if (plan.TargetExisted) Directory.CreateDirectory(plan.TargetRoot);
            return;
        }
        await RequireFingerprintAsync(plan.TargetRoot, plan, "rollback-verify", null, cancellationToken);
        if (!Directory.Exists(plan.SourceRoot)) throw new IOException("Cloudig Library rollback source is missing.");
        Directory.Delete(plan.TargetRoot, true);
        if (plan.TargetExisted) Directory.CreateDirectory(plan.TargetRoot);
    }

    public static string DisplayPath(string root)
    {
        var full = NormalizeRoot(root);
        var drive = Path.GetPathRoot(full)!.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var tail = full[Path.GetPathRoot(full)!.Length..]
            .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)
            .TakeLast(2)
            .Select(value => value.Length <= 80 ? value : $"{value[..35]}…{value[^35..]}")
            .ToArray();
        return tail.Length == 0 ? drive : $"{drive} / … / {string.Join(" / ", tail)}";
    }

    private static async Task RequireFingerprintAsync(
        string root,
        LibraryMovePlan plan,
        string phase,
        Action<LibraryMoveProgress>? progress,
        CancellationToken cancellationToken)
    {
        ValidatePlan(plan);
        var observed = await FingerprintAsync(root, phase, progress, cancellationToken);
        if (observed.TotalBytes != plan.TotalBytes
            || observed.Files.Count != plan.TotalFiles
            || observed.Directories.Count != plan.TotalDirectories
            || !FixedHashEquals(observed.ManifestSha256, plan.ManifestSha256))
        {
            throw new IOException("Cloudig Library changed during the move.");
        }
    }

    public static void ValidatePlan(LibraryMovePlan plan)
    {
        if (plan.Files is null || plan.Directories is null || plan.TotalFiles != plan.Files.Count || plan.TotalDirectories != plan.Directories.Count || plan.TotalFiles > LibraryMoveLimits.MaximumFiles || plan.TotalBytes < 0)
            throw new InvalidDataException("Move manifest counts are invalid.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long bytes = 0;
        foreach (var directory in plan.Directories)
        { ResolveRelative(plan.SourceRoot, directory); if (!names.Add(directory)) throw new InvalidDataException("Move manifest paths are duplicated."); }
        foreach (var file in plan.Files)
        {
            ResolveRelative(plan.SourceRoot, file.RelativePath);
            if (!names.Add(file.RelativePath) || file.Bytes < 0 || file.Sha256 is not { Length: 64 } || file.Sha256.Any(c => !char.IsAsciiHexDigit(c)) || (file.Attributes & (int)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Move manifest file information is invalid.");
            bytes = checked(bytes + file.Bytes);
        }
        if (bytes != plan.TotalBytes || !FixedHashEquals(ManifestHash(plan.Directories, plan.Files), plan.ManifestSha256)) throw new InvalidDataException("Move manifest rows do not match its fingerprint.");
    }

    private static async Task<Fingerprint> FingerprintAsync(
        string root,
        string phase,
        Action<LibraryMoveProgress>? progress,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizeRoot(root);
        if (!Directory.Exists(normalized)) throw new DirectoryNotFoundException("Cloudig Library root is missing.");
        RequireNotReparse(normalized);
        var directories = new List<string>();
        var files = new List<(string Relative, string Absolute, long Bytes, long Created, long Modified, int Attributes)>();
        var stack = new Stack<string>();
        stack.Push(normalized);
        long totalBytes = 0;
        while (stack.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var current = stack.Pop();
            foreach (var entry in Directory.EnumerateFileSystemEntries(current))
            {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Cloudig Library cannot contain reparse points during a move.");
                var relative = RelativePath(normalized, entry);
                if (relative is "appdata/Move/request.json" or "appdata/Move/result.json") continue;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    directories.Add(relative);
                    stack.Push(entry);
                }
                else
                {
                    var info = new FileInfo(entry);
                    var bytes = info.Length;
                    totalBytes = checked(totalBytes + bytes);
                    files.Add((relative, entry, bytes, info.CreationTimeUtc.Ticks, info.LastWriteTimeUtc.Ticks, (int)info.Attributes));
                    if (files.Count > LibraryMoveLimits.MaximumFiles) throw new InvalidDataException("Cloudig Library contains too many files for one move operation.");
                }
            }
        }
        directories.Sort(StringComparer.Ordinal);
        files.Sort((left, right) => StringComparer.Ordinal.Compare(left.Relative, right.Relative));
        var rows = new List<LibraryMoveFile>(files.Count);
        long completedBytes = 0;
        var completedFiles = 0;
        foreach (var file in files)
        {
            var hashed = await HashFileAsync(file.Absolute, value =>
            {
                progress?.Invoke(new LibraryMoveProgress(phase, completedBytes + value, totalBytes, completedFiles, files.Count));
            }, cancellationToken);
            var finalInfo = new FileInfo(file.Absolute);
            if (hashed.Bytes != file.Bytes
                || finalInfo.Length != file.Bytes
                || finalInfo.CreationTimeUtc.Ticks != file.Created
                || finalInfo.LastWriteTimeUtc.Ticks != file.Modified
                || (int)finalInfo.Attributes != file.Attributes)
            {
                throw new IOException($"Cloudig Library file changed while hashing: {file.Relative}");
            }
            rows.Add(new LibraryMoveFile(file.Relative, hashed.Bytes, hashed.Sha256, file.Created, file.Modified, file.Attributes));
            completedBytes += hashed.Bytes;
            completedFiles += 1;
            progress?.Invoke(new LibraryMoveProgress(phase, completedBytes, totalBytes, completedFiles, files.Count));
        }
        return new Fingerprint(directories, rows, totalBytes, ManifestHash(directories, rows));
    }

    private static async Task<(long Bytes, string Sha256)> HashFileAsync(string file, Action<long>? progress, CancellationToken cancellationToken)
    {
        await using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[BufferBytes];
        long completed = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (read == 0) break;
            hash.AppendData(buffer, 0, read);
            completed = checked(completed + read);
            progress?.Invoke(completed);
        }
        return (completed, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
    }

    private static async Task<(long Bytes, string Sha256)> CopyAndHashAsync(string source, string destination, Action<long>? progress, CancellationToken cancellationToken)
    {
        await using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferBytes, FileOptions.Asynchronous | FileOptions.WriteThrough);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[BufferBytes];
        long completed = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (read == 0) break;
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            hash.AppendData(buffer, 0, read);
            completed = checked(completed + read);
            progress?.Invoke(completed);
        }
        await output.FlushAsync(cancellationToken);
        output.Flush(true);
        return (completed, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
    }

    private static string ManifestHash(IReadOnlyList<string> directories, IReadOnlyList<LibraryMoveFile> files)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[8];
        Span<byte> attributes = stackalloc byte[4];
        foreach (var directory in directories)
        {
            hash.AppendData([0x44]);
            AppendString(hash, directory);
        }
        foreach (var file in files)
        {
            hash.AppendData([0x46]);
            AppendString(hash, file.RelativePath);
            BinaryPrimitives.WriteInt64BigEndian(length, file.Bytes);
            hash.AppendData(length);
            hash.AppendData(Convert.FromHexString(file.Sha256));
            BinaryPrimitives.WriteInt64BigEndian(length, file.CreationTimeUtcTicks);
            hash.AppendData(length);
            BinaryPrimitives.WriteInt64BigEndian(length, file.LastWriteTimeUtcTicks);
            hash.AppendData(length);
            BinaryPrimitives.WriteInt32BigEndian(attributes, file.Attributes);
            hash.AppendData(attributes);
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static void AppendString(IncrementalHash hash, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }

    private static string RelativePath(string root, string value)
    {
        var relative = Path.GetRelativePath(root, value).Replace(Path.DirectorySeparatorChar, '/');
        if (relative is "" or "." or ".." || relative.StartsWith("../", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            throw new InvalidDataException("Cloudig Library path escaped its root.");
        }
        return relative;
    }

    private static string ResolveRelative(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || relative.Contains('\\') || relative.Contains(':') || relative.Split('/').Any(value => value is "" or "." or ".."))
        {
            throw new InvalidDataException("Cloudig Library manifest path is invalid.");
        }
        var full = Path.GetFullPath(Path.Combine([root, .. relative.Split('/')]));
        var prefix = NormalizeRoot(root) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Cloudig Library manifest path escaped its root.");
        return full;
    }

    private static string NormalizeRoot(string value) => Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static void ValidatePair(string source, string target)
    {
        if (source.Equals(target, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Cloudig Library source and target are the same.");
        var sourcePrefix = source + Path.DirectorySeparatorChar;
        var targetPrefix = target + Path.DirectorySeparatorChar;
        if (target.StartsWith(sourcePrefix, StringComparison.OrdinalIgnoreCase) || source.StartsWith(targetPrefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Cloudig Library cannot move inside itself or into its descendant.");
        }
        RequireNotReparse(source);
        ValidateAncestors(source);
        ValidateAncestors(Path.GetDirectoryName(target) ?? throw new InvalidDataException("Cloudig Library target parent is invalid."));
    }

    private static void ValidateAncestors(string directory)
    {
        var current = new DirectoryInfo(Path.GetFullPath(directory));
        while (current is not null)
        {
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Cloudig Library target path cannot pass through a reparse point.");
            current = current.Parent;
        }
    }

    private static bool ValidateEmptyTarget(string target, bool? expectedExisted = null)
    {
        if (File.Exists(target)) throw new InvalidDataException("Cloudig Library target is a file.");
        var exists = Directory.Exists(target);
        if (expectedExisted is not null && exists != expectedExisted) throw new IOException("Cloudig Library target state changed after planning.");
        if (!exists) return false;
        RequireNotReparse(target);
        if (Directory.EnumerateFileSystemEntries(target).Any()) throw new InvalidDataException("Cloudig Library target must be empty.");
        return true;
    }

    private static void RequireLibraryShape(string root)
    {
        foreach (var relative in new[] { "Cloudig.exe", "CloudigLibrary.json", "app/Cloudig.dll" })
        {
            if (!File.Exists(ResolveRelative(root, relative))) throw new InvalidDataException($"Cloudig Library authority file is missing: {relative}");
        }
    }

    private static void RequireNotReparse(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Cloudig Library move does not accept reparse points.");
    }

    private static void RequireCapacity(string target, long totalBytes)
    {
        var root = Path.GetPathRoot(target) ?? throw new InvalidDataException("Cloudig Library target volume is invalid.");
        var drive = new DriveInfo(root);
        var reserve = Math.Max(LibraryMoveLimits.MinimumReserveBytes, totalBytes / LibraryMoveLimits.ReserveDivisor);
        if (drive.AvailableFreeSpace < checked(totalBytes + reserve)) throw new IOException("Cloudig Library target volume does not have enough free space.");
    }

    private static bool FixedHashEquals(string left, string right)
    {
        var leftBytes = Encoding.ASCII.GetBytes(left);
        var rightBytes = Encoding.ASCII.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private sealed record Fingerprint(IReadOnlyList<string> Directories, IReadOnlyList<LibraryMoveFile> Files, long TotalBytes, string ManifestSha256);
}
