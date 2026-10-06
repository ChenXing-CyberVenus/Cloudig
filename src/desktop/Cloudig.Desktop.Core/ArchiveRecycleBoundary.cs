using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

public static class ArchiveRecycleBoundary
{
    private static readonly Regex Sha256 = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex MarkName = new("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$", RegexOptions.CultureInvariant);
    private static readonly Regex InvalidSegment = new("[<>:\"\\\\|?*\\x00-\\x1f]|[ .]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    public static async Task<string> VerifyExactFileAsync(
        string libraryRoot,
        string managedPath,
        long expectedBytes,
        string expectedSha256,
        CancellationToken cancellationToken = default)
    {
        if (expectedBytes < 1 || !Sha256.IsMatch(expectedSha256)) throw new InvalidDataException("Recycle fingerprint is invalid.");
        var root = Path.GetFullPath(libraryRoot);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException("Library root is missing.");
        RejectReparse(root, directory: true);

        if (managedPath.Length is 0 or > 1024 || Path.IsPathFullyQualified(managedPath) || managedPath.Contains('\\') || managedPath.Contains('\0'))
        {
            throw new InvalidDataException("Recycle path is not a managed relative path.");
        }
        var segments = managedPath.Split('/', StringSplitOptions.None);
        if (segments.Length < 2
            || (segments[0] is not ("Conversations" or "Archives") && !(segments[0] == "Marks" && segments.Length == 2 && MarkName.IsMatch(segments[1])))
            || segments.Any(segment => string.IsNullOrEmpty(segment) || segment is "." or ".." || InvalidSegment.IsMatch(segment))
            || !segments[^1].EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Recycle path is outside the editable Conversation scope.");
        }

        var current = root;
        for (var index = 0; index < segments.Length - 1; index++)
        {
            current = Path.Combine(current, segments[index]);
            RejectReparse(current, directory: true);
        }
        var target = Path.GetFullPath(Path.Combine(root, Path.Combine(segments)));
        var relative = Path.GetRelativePath(root, target);
        if (relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathFullyQualified(relative))
        {
            throw new InvalidDataException("Recycle path escapes the Library root.");
        }
        RejectReparse(target, directory: false);

        await using var stream = new FileStream(
            target,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            1024 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length != expectedBytes) throw new InvalidDataException("Recycle target byte count changed.");
        var observed = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(observed), Convert.FromHexString(expectedSha256)))
        {
            throw new InvalidDataException("Recycle target content changed.");
        }
        return target;
    }

    public static async Task<int> RecycleFilesAsync(string libraryRoot, JsonElement files, Func<string, CancellationToken, Task> recycle, CancellationToken cancellationToken = default)
    {
        if (files.ValueKind != JsonValueKind.Array || files.GetArrayLength() > 2) throw new InvalidDataException("A recycle plan contains at most a Conversation and its Mark.");
        var targets = new List<(string Path, long Bytes, string Sha)>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var kinds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in files.EnumerateArray())
        {
            var kind = file.GetProperty("kind").GetString();
            var relative = file.GetProperty("path").GetString() ?? throw new InvalidDataException("Recycle path is missing.");
            var bytes = file.GetProperty("bytes").GetInt64();
            var sha = file.GetProperty("sha256").GetString() ?? throw new InvalidDataException("Recycle fingerprint is missing.");
            if (kind is not ("conversation" or "mark") || !kinds.Add(kind) || !paths.Add(relative) || (kind == "mark") != relative.StartsWith("Marks/", StringComparison.Ordinal)) throw new InvalidDataException("Recycle record kinds are inconsistent.");
            await VerifyExactFileAsync(libraryRoot, relative, bytes, sha, cancellationToken);
            targets.Add((relative, bytes, sha));
        }
        // Verify every file before the first deletion, then recheck each exact file at its turn.
        var completed = 0;
        foreach (var target in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var absolute = await VerifyExactFileAsync(libraryRoot, target.Path, target.Bytes, target.Sha, cancellationToken);
            await recycle(absolute, cancellationToken);
            if (File.Exists(absolute)) throw new IOException("Windows Recycle Bin did not remove the selected original.");
            completed++;
        }
        return completed;
    }

    private static void RejectReparse(string path, bool directory)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Recycle path crosses a reparse point.");
        if (directory && (attributes & FileAttributes.Directory) == 0) throw new InvalidDataException("Recycle parent is not a directory.");
        if (!directory && (attributes & FileAttributes.Directory) != 0) throw new InvalidDataException("Recycle target is not a regular file.");
    }
}
