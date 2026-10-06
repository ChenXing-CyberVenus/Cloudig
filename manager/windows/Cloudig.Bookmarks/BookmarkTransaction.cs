using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public sealed class BookmarkTransaction
{
    private const string PendingFileName = "pending-transaction.txt";
    private readonly IBookmarkMutator _editor;
    private readonly string _backupRoot;

    public BookmarkTransaction(IBookmarkMutator editor, string backupRoot)
    {
        _editor = editor ?? throw new ArgumentNullException(nameof(editor));
        _backupRoot = string.IsNullOrWhiteSpace(backupRoot)
            ? throw new ArgumentException("Cloudig Chrome backup directory is required.", nameof(backupRoot))
            : Path.GetFullPath(backupRoot);
    }

    public Action<int, BookmarkStore>? BeforeWriteForTests { get; set; }

    public BookmarkTransactionResult Execute(
        IEnumerable<BookmarkStore> stores,
        BookmarkOperation operation,
        DateTime utcNow)
    {
        var selected = stores
            .Where(store => store is not null)
            .GroupBy(store => Path.GetFullPath(store.Path), StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();
        if (selected.Length == 0) throw new InvalidOperationException("No Chrome bookmark stores were selected.");

        Directory.CreateDirectory(_backupRoot);
        // Prevent one installer from retiring another active transaction's
        // rollback. The lock disappears on close, including process failure.
        using var backupLock = new FileStream(Path.Combine(_backupRoot, ".transaction.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);

        var plans = selected.Select(store => CreatePlan(store, operation, utcNow)).ToArray();
        var changed = plans.Where(plan => plan.Mutation.Changed).ToArray();
        if (changed.Length == 0)
        {
            BookmarkBackupRetention.Prune(_backupRoot);
            return new BookmarkTransactionResult(null, plans.Select(ToResult).ToArray());
        }

        var timestamp = utcNow.ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'", System.Globalization.CultureInfo.InvariantCulture);
        var backupDirectory = Path.Combine(_backupRoot, $"{timestamp}-{Guid.NewGuid():N}"[..(timestamp.Length + 9)]);
        Directory.CreateDirectory(backupDirectory);
        var backupVerified = false;
        try
        {
            for (var index = 0; index < changed.Length; index++)
            {
                var plan = changed[index];
                var backupName = $"{index + 1:D2}-{SafeName(plan.Store.ProfileDirectory)}-{SafeName(Path.GetFileName(plan.Store.Path))}.json";
                plan.BackupPath = Path.Combine(backupDirectory, backupName);
                File.Copy(plan.Store.Path, plan.BackupPath, overwrite: false);
                if (!FixedHashEquals(FileSha256(plan.BackupPath), plan.OriginalSha256))
                {
                    throw new IOException($"Cloudig Chrome bookmark backup verification failed before writing: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                }
            }
            WriteBackupManifest(backupDirectory, operation, utcNow, changed);
            // An extra owned file also protects this group from older retention
            // code, which only retires exact completed manifest/file sets.
            WriteNewFile(Path.Combine(backupDirectory, PendingFileName), BookmarkJson.Utf8(
                "Cloudig bookmark transaction is unfinished. Keep this complete backup until recovery is resolved.\n"));
            backupVerified = true;
        }
        finally
        {
            if (!backupVerified)
            {
                foreach (var plan in changed)
                    if (plan.BackupPath is not null) File.Delete(plan.BackupPath);
                File.Delete(Path.Combine(backupDirectory, "backup-manifest.json"));
                File.Delete(Path.Combine(backupDirectory, PendingFileName));
                Directory.Delete(backupDirectory, recursive: false);
            }
        }
        // Keep the current verified group plus the newest previous one. Do this
        // before Chrome writes: a cleanup failure must not report failure after
        // a successful install, and write/rollback failures must remain bounded.
        BookmarkBackupRetention.Prune(_backupRoot, backupDirectory);

        var written = new List<Plan>();
        try
        {
            for (var index = 0; index < changed.Length; index++)
            {
                var plan = changed[index];
                BeforeWriteForTests?.Invoke(index, plan.Store);
                if (!FixedHashEquals(FileSha256(plan.Store.Path), plan.OriginalSha256))
                {
                    throw new IOException($"Chrome bookmarks changed after preflight: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                }
                written.Add(plan);
                WriteAtomically(plan.Store.Path, BookmarkJson.Utf8(plan.Mutation.Json));
                if (!FixedHashEquals(FileSha256(plan.Store.Path), plan.ResultSha256))
                {
                    throw new IOException($"Chrome bookmark hash verification failed after writing: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                }
            }
            File.Delete(Path.Combine(backupDirectory, PendingFileName));
        }
        catch (Exception writeError)
        {
            var rollbackErrors = new List<Exception>();
            for (var index = written.Count - 1; index >= 0; index--)
            {
                var plan = written[index];
                try
                {
                    var currentHash = FileSha256(plan.Store.Path);
                    if (FixedHashEquals(currentHash, plan.OriginalSha256)) continue;
                    if (!FixedHashEquals(currentHash, plan.ResultSha256))
                        throw new IOException($"Chrome bookmarks changed after Cloudig wrote them; recovery did not overwrite the newer file: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                    var original = File.ReadAllBytes(plan.BackupPath!);
                    if (!FixedHashEquals(Sha256(original), plan.OriginalSha256))
                        throw new IOException($"The saved Chrome bookmark backup changed; recovery did not replace the current file: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                    WriteAtomically(plan.Store.Path, original);
                    if (!FixedHashEquals(FileSha256(plan.Store.Path), plan.OriginalSha256))
                    {
                        throw new IOException($"Rollback hash did not match: {plan.Store.ProfileDisplayName}/{plan.Store.Kind}");
                    }
                }
                catch (Exception rollbackError)
                {
                    rollbackErrors.Add(rollbackError);
                }
            }
            if (rollbackErrors.Count == 0)
            {
                try { File.Delete(Path.Combine(backupDirectory, PendingFileName)); }
                catch (Exception cleanupError) { rollbackErrors.Add(cleanupError); }
            }
            if (rollbackErrors.Count > 0)
            {
                rollbackErrors.Insert(0, writeError);
                throw new AggregateException($"Cloudig bookmark transaction failed and at least one store could not be rolled back. Backups remain at {backupDirectory}", rollbackErrors);
            }
            throw new InvalidOperationException($"Cloudig bookmark transaction failed; every written store was restored from {backupDirectory}", writeError);
        }

        return new BookmarkTransactionResult(backupDirectory, plans.Select(ToResult).ToArray());
    }

    private Plan CreatePlan(BookmarkStore store, BookmarkOperation operation, DateTime utcNow)
    {
        if (!File.Exists(store.Path)) throw new FileNotFoundException("Chrome bookmark store does not exist.", store.Path);
        var originalBytes = ChromeProfileDiscovery.ReadAllBytesShared(store.Path);
        var originalJson = ChromeProfileDiscovery.DecodeUtf8(originalBytes);
        var mutation = ChromeBookmarkSync.Apply(originalJson, _editor.Mutate(originalJson, operation, utcNow), utcNow);
        return new Plan
        {
            Store = store,
            Mutation = mutation,
            OriginalSha256 = Sha256(originalBytes),
            ResultSha256 = Sha256(BookmarkJson.Utf8(mutation.Json))
        };
    }

    private static BookmarkStoreResult ToResult(Plan plan) => new(
        plan.Store,
        plan.Mutation,
        plan.OriginalSha256,
        plan.ResultSha256,
        plan.BackupPath);

    private static void WriteBackupManifest(
        string directory,
        BookmarkOperation operation,
        DateTime utcNow,
        IReadOnlyList<Plan> plans)
    {
        var files = new JsonArray();
        foreach (var plan in plans)
        {
            files.Add((JsonNode)new JsonObject
            {
                ["source_path"] = plan.Store.Path,
                ["backup_file"] = Path.GetFileName(plan.BackupPath),
                ["profile"] = plan.Store.ProfileDirectory,
                ["store_kind"] = plan.Store.Kind,
                ["original_sha256"] = plan.OriginalSha256,
                ["result_sha256"] = plan.ResultSha256
            });
        }
        var manifest = new JsonObject
        {
            ["format"] = "cloudig/chrome-bookmark-backup",
            ["version"] = "0.1.0",
            ["created_at"] = utcNow.ToUniversalTime().ToString("O"),
            ["operation"] = operation.ToString(),
            ["files"] = files
        };
        WriteNewFile(
            Path.Combine(directory, "backup-manifest.json"),
            BookmarkJson.Utf8(manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine));
    }

    private static void WriteAtomically(string destination, byte[] bytes)
    {
        var temporary = $"{destination}.cloudig-{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Replace(temporary, destination, destinationBackupFileName: null, ignoreMetadataErrors: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteNewFile(string destination, byte[] bytes)
    {
        var temporary = $"{destination}.tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16384, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, destination);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static string FileSha256(string path)
    {
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool FixedHashEquals(string left, string right) => ChromeBookmarkChecksums.FixedHexEquals(left, right);

    private static string SafeName(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "unknown";
        return Path.GetInvalidFileNameChars().Aggregate(value, (current, invalid) => current.Replace(invalid, '_'));
    }

    private sealed class Plan
    {
        public required BookmarkStore Store { get; init; }
        public required BookmarkMutation Mutation { get; init; }
        public required string OriginalSha256 { get; init; }
        public required string ResultSha256 { get; init; }
        public string? BackupPath { get; set; }
    }
}
