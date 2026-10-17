using System.Text;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

internal static class BookmarkTransactionAudit
{
    public static int Run(string projectRoot, BookmarkPackage package)
    {
        var parent = Path.Combine(projectRoot, "manager", ".test-temp");
        Directory.CreateDirectory(parent);
        var root = Path.Combine(parent, $"transaction-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var passed = false; var checks = 0;
        void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); checks++; }
        var errors = new List<Exception>();
        void Probe(string name, Action<string> action)
        {
            var scope = Path.Combine(root, name); Directory.CreateDirectory(scope);
            try { action(scope); Console.WriteLine($"PASS {name}"); }
            catch (Exception error) { errors.Add(new InvalidOperationException(name, error)); Console.WriteLine($"FAIL {name}: {error.Message}"); }
        }
        var now = new DateTime(2026, 9, 21, 12, 0, 0, DateTimeKind.Utc);
        BookmarkTransaction Transaction(string scope) => new(new BookmarkFileEditor(package, selectedBookmarkIds: ["chatgpt"]), Path.Combine(scope, "Backups"));
        BookmarkStore Store(string scope, string name) { var file = Path.Combine(scope, name); File.WriteAllText(file, Empty(), new UTF8Encoding(false)); return new(name, name, "local", file); }
        Exception Fail(BookmarkTransaction transaction, BookmarkStore[] stores)
        {
            try { transaction.Execute(stores, BookmarkOperation.InstallOrRepair, now); }
            catch (Exception error) { return error; }
            throw new InvalidOperationException("The injected transaction failure was ignored");
        }
        try
        {
            Probe("preserve-later-external-write", scope => {
                var first = Store(scope, "first"); var second = Store(scope, "second"); var transaction = Transaction(scope);
                string? external = null;
                transaction.BeforeWriteForTests = (index, _) => {
                    if (index != 1) return;
                    var document = JsonNode.Parse(File.ReadAllText(first.Path))!.AsObject(); document["external_writer"] = "new content after Cloudig wrote";
                    external = document.ToJsonString(); File.WriteAllText(first.Path, external, new UTF8Encoding(false));
                    throw new IOException("second write failed");
                };
                var error = Fail(transaction, [first, second]);
                Check(File.ReadAllText(first.Path) == external, "Rollback overwrote a later external write");
                Check(error is AggregateException, "Conflicting rollback must report incomplete recovery");
            });
            Probe("validate-backup-before-restoring", scope => {
                var first = Store(scope, "first"); var second = Store(scope, "second"); var transaction = Transaction(scope);
                string? installed = null;
                transaction.BeforeWriteForTests = (index, _) => {
                    if (index != 1) return;
                    installed = File.ReadAllText(first.Path);
                    var group = Directory.GetDirectories(Path.Combine(scope, "Backups")).Single();
                    var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(group, "backup-manifest.json")))!;
                    var backup = manifest["files"]![0]!["backup_file"]!.GetValue<string>();
                    File.WriteAllText(Path.Combine(group, backup), "corrupt backup", new UTF8Encoding(false));
                    throw new IOException("second write failed");
                };
                Fail(transaction, [first, second]);
                Check(File.ReadAllText(first.Path) == installed, "A corrupt backup replaced the intact installed bookmark file");
            });
            Probe("retain-needed-rollback-through-rotation", scope => {
                var first = Store(scope, "first"); var second = Store(scope, "second"); var third = Store(scope, "third"); var transaction = Transaction(scope);
                var original = File.ReadAllBytes(first.Path); FileStream? hold = null;
                transaction.BeforeWriteForTests = (index, _) => {
                    if (index != 1) return;
                    hold = new FileStream(first.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
                    throw new IOException("second write failed while first store is locked");
                };
                try { Check(Fail(transaction, [first, second]) is AggregateException, "The locked file must make rollback incomplete"); }
                finally { hold?.Dispose(); }
                var backupRoot = Path.Combine(scope, "Backups"); var failedGroup = Directory.GetDirectories(backupRoot).Single();
                var saved = JsonNode.Parse(File.ReadAllText(Path.Combine(failedGroup, "backup-manifest.json")))!;
                var originalFile = Path.Combine(failedGroup, saved["files"]![0]!["backup_file"]!.GetValue<string>());
                var next = Transaction(scope);
                for (var i=1;i<=4;i++) next.Execute([third], i%2==1 ? BookmarkOperation.InstallOrRepair : BookmarkOperation.Remove, now.AddMinutes(i));
                Check(File.Exists(originalFile) && File.ReadAllBytes(originalFile).SequenceEqual(original), "Backup rotation deleted the only original of an incomplete rollback");
                Check(Directory.GetDirectories(backupRoot).Count(d => d != failedGroup) <= 2, "Completed backups must still stay bounded");
            });
            Probe("record-pending-before-first-write", scope => {
                var first = Store(scope, "first"); var transaction = Transaction(scope); var protectedBeforeWrite = false;
                transaction.BeforeWriteForTests = (_, _) => {
                    var group = Directory.GetDirectories(Path.Combine(scope, "Backups")).Single();
                    protectedBeforeWrite = File.Exists(Path.Combine(group, "pending-transaction.txt"));
                };
                transaction.Execute([first], BookmarkOperation.InstallOrRepair, now);
                Check(protectedBeforeWrite, "A process exit during a write would leave no unfinished-backup marker");
                Check(!Directory.EnumerateFiles(Path.Combine(scope, "Backups"), "pending-transaction.txt", SearchOption.AllDirectories).Any(), "A completed transaction still looks unfinished");
            });
            if (errors.Count > 0) throw new AggregateException(errors);
            passed = true; return checks;
        }
        finally
        {
            if (passed)
            {
                if (Path.GetDirectoryName(Path.GetFullPath(root)) != Path.GetFullPath(parent)
                    || (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("Unexpected test retirement target");
                Directory.Delete(root, recursive:true);
            }
            else Console.WriteLine($"Retained owned transaction fixture: {root}");
        }
    }

    private static string Empty()
    {
        var roots = new JsonObject();
        var id = 0;
        foreach (var name in new[] { "bookmark_bar", "other", "synced" })
            roots[name] = new JsonObject { ["id"]=(++id).ToString(), ["guid"]=Guid.NewGuid().ToString("D"), ["name"]=name, ["type"]="folder", ["children"]=new JsonArray(), ["date_added"]="0", ["date_modified"]="0" };
        var document = new JsonObject { ["roots"]=roots, ["version"]=1 };
        var sums = ChromeBookmarkChecksums.Compute(document); document["checksum"]=sums.Md5; document["checksum_sha256"]=sums.Sha256;
        return document.ToJsonString();
    }
}
