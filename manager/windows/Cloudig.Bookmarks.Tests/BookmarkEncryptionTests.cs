using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

internal static class BookmarkEncryptionTests
{
    private static readonly DateTime Now = new(2026, 11, 12, 6, 0, 0, DateTimeKind.Utc);

    internal static async Task Run(string? chrome = null)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows DPAPI integration test");
        var project = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../.."));
        var parent = Path.Combine(project, "manager", ".test-temp");
        var root = Path.Combine(parent, "encrypted-bookmarks-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var checks = 0; var passed = false;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); checks++; }
        void Reject(Action action, string message)
        {
            try { action(); } catch (Exception error) when (error is IOException or CryptographicException or InvalidOperationException or AggregateException) { checks++; return; }
            throw new InvalidOperationException(message);
        }
        try
        {
            var store = MakeStore(Path.Combine(root, "unit"));
            var encrypted = ChromeBookmarkEncryption.CompanionPath(store.Path)!;
            using var cipher = ChromeBookmarkEncryption.Open(store.Path);
            var original = File.ReadAllBytes(store.Path);
            var originalEncrypted = File.ReadAllBytes(encrypted);
            Check(cipher.Decrypt(originalEncrypted).SequenceEqual(original), "DPAPI/v10 read changed content");
            Check(!cipher.Encrypt(original).SequenceEqual(cipher.Encrypt(original)), "GCM nonce was reused");
            var corrupt = originalEncrypted.ToArray(); corrupt[^1] ^= 1;
            Reject(() => cipher.Decrypt(corrupt), "Authentication failure was ignored");
            var unknown = originalEncrypted.ToArray(); unknown[1] = (byte)'2';
            Reject(() => cipher.Decrypt(unknown), "Unknown encryption format was accepted");

            var backups = Path.Combine(root, "backups");
            var first = Transaction(backups, "1.0.0").Execute([store], BookmarkOperation.InstallOrRepair, Now);
            Check(first.Stores.Count == 1 && first.AddedCount == 2, "Companion doubled logical result counts (folder + bookmark)");
            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(first.BackupDirectory!, "backup-manifest.json")))!;
            Check(manifest["files"]!.AsArray().Count == 2, "Pair was not backed up together");
            Check(File.ReadAllBytes(Path.Combine(first.BackupDirectory!, manifest["files"]![0]!["backup_file"]!.GetValue<string>())).SequenceEqual(original), "Clear backup differs");
            Check(File.ReadAllBytes(Path.Combine(first.BackupDirectory!, manifest["files"]![1]!["backup_file"]!.GetValue<string>())).SequenceEqual(originalEncrypted), "Encrypted backup differs");
            Check(cipher.Decrypt(File.ReadAllBytes(encrypted)).SequenceEqual(File.ReadAllBytes(store.Path)), "Updated pair differs");
            var beforeNoop = File.ReadAllBytes(encrypted);
            Check(Transaction(backups, "1.0.0").Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(1)).ChangedStoreCount == 0, "No-op rewrote store");
            Check(beforeNoop.SequenceEqual(File.ReadAllBytes(encrypted)), "No-op churned encrypted bytes");

            var beforeFailure = File.ReadAllBytes(store.Path);
            var failing = Transaction(backups, "2.0.0");
            failing.BeforeWriteForTests = (index, _) => { if (index == 1) throw new IOException("injected second write failure"); };
            Reject(() => failing.Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(2)), "Second failure ignored");
            Check(File.ReadAllBytes(store.Path).SequenceEqual(beforeFailure) && File.ReadAllBytes(encrypted).SequenceEqual(beforeNoop), "Pair rollback changed originals");
            var update = Transaction(backups, "2.0.0").Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(3));
            Check(update.UpdatedCount == 1 && Version(store.Path) == "2.0.0", "Incremental update failed");
            Check(cipher.Decrypt(File.ReadAllBytes(encrypted)).SequenceEqual(File.ReadAllBytes(store.Path)), "Incremental pair differs");

            var pairBeforeRollback = File.ReadAllBytes(store.Path); var cipherBeforeRollback = File.ReadAllBytes(encrypted);
            var laterStore = MakeStore(Path.Combine(root, "later"), encrypted: false);
            var laterFailure = Transaction(backups, "3.0.0");
            laterFailure.BeforeWriteForTests = (index, _) => { if (index == 2) throw new IOException("injected after both pair writes"); };
            Reject(() => laterFailure.Execute([store, laterStore], BookmarkOperation.InstallOrRepair, Now.AddMilliseconds(3500)), "Failure after pair ignored");
            Check(File.ReadAllBytes(store.Path).SequenceEqual(pairBeforeRollback) && File.ReadAllBytes(encrypted).SequenceEqual(cipherBeforeRollback), "Both written files did not roll back byte-for-byte");

            var intact = File.ReadAllBytes(store.Path); var intactEncrypted = File.ReadAllBytes(encrypted);
            var divergent = JsonNode.Parse(intact)!.AsObject(); divergent["external_change"] = true;
            File.WriteAllBytes(encrypted, cipher.Encrypt(Encoding.UTF8.GetBytes(divergent.ToJsonString())));
            Reject(() => Transaction(backups, "3.0.0").Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(4)), "Divergent stores were merged by guessing");
            Check(File.ReadAllBytes(store.Path).SequenceEqual(intact), "Divergence changed clear store");
            File.WriteAllBytes(encrypted, unknown);
            Reject(() => Transaction(backups, "3.0.0").Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(5)), "Unknown encrypted store was silently ignored");
            Check(File.ReadAllBytes(store.Path).SequenceEqual(intact), "Unknown encoding changed clear store");
            File.WriteAllBytes(encrypted, intactEncrypted);

            var external = Transaction(backups, "3.0.0");
            external.BeforeWriteForTests = (index, _) => { if (index == 1) { File.WriteAllText(store.Path, "external writer"); throw new IOException("injected"); } };
            Reject(() => external.Execute([store], BookmarkOperation.InstallOrRepair, Now.AddSeconds(6)), "External write was overwritten");
            Check(File.ReadAllText(store.Path) == "external writer", "Rollback overwrote later external content");
            Check(Directory.EnumerateFiles(backups, "pending-transaction.txt", SearchOption.AllDirectories).Any(), "Unfinished rollback lost marker");

            var plain = MakeStore(Path.Combine(root, "legacy"), encrypted: false);
            Transaction(Path.Combine(root, "legacy-backups"), "1.0.0").Execute([plain], BookmarkOperation.InstallOrRepair, Now);
            Check(Version(plain.Path) == "1.0.0" && !File.Exists(ChromeBookmarkEncryption.CompanionPath(plain.Path)), "Legacy store behavior changed");
            var account = MakeStore(Path.Combine(root, "account"), fileName: "AccountBookmarks");
            Transaction(Path.Combine(root, "account-backups"), "1.0.0").Execute([account], BookmarkOperation.InstallOrRepair, Now);
            using (var accountCipher = ChromeBookmarkEncryption.Open(account.Path))
                Check(accountCipher.Decrypt(File.ReadAllBytes(ChromeBookmarkEncryption.CompanionPath(account.Path)!)).SequenceEqual(File.ReadAllBytes(account.Path)), "Account pair differs");

            var accountRoot = Directory.GetParent(Path.GetDirectoryName(account.Path)!)!.FullName;
            Check(ChromeProfileDiscovery.Discover(accountRoot).Single().Stores.Single().Path == account.Path, "Official account filename was not discovered");
            var encryptedAccountPath = ChromeBookmarkEncryption.CompanionPath(account.Path)!;
            Check(ChromeProfileDiscovery.SameLogicalStore(account.Path, encryptedAccountPath), "Encrypted migration lost logical account identity");
            Check(!ChromeProfileDiscovery.SameLogicalStore(account.Path, store.Path), "Different profiles were treated as one store");
            Check(!ChromeProfileDiscovery.SameLogicalStore(account.Path, Path.Combine(Path.GetDirectoryName(account.Path)!, "Bookmarks")), "Local/account trees were conflated");
            File.Delete(account.Path); // This test's own fixture, simulating Chrome's encrypted-only stage.
            var accountOnly = ChromeProfileDiscovery.Discover(accountRoot).Single().Stores.Single();
            Check(accountOnly.Path == encryptedAccountPath && accountOnly.Kind == "account", "Encrypted-only account was not discovered");
            var onlyBackups = Path.Combine(root, "only-backups");
            for (var n = 2; n <= 5; n++) Transaction(onlyBackups, $"{n}.0.0").Execute([accountOnly], BookmarkOperation.InstallOrRepair, Now.AddSeconds(n));
            Check(Version(accountOnly.Path) == "5.0.0", "Encrypted-only update failed");
            Check(!File.Exists(account.Path), "Encrypted-only update created a plaintext store");
            Check(Directory.GetDirectories(onlyBackups).Length == 2, "Encrypted-only backups grew beyond two groups");
            var unchangedCipher = File.ReadAllBytes(accountOnly.Path);
            Check(Transaction(onlyBackups, "5.0.0").Execute([accountOnly], BookmarkOperation.InstallOrRepair, Now.AddSeconds(9)).ChangedStoreCount == 0, "Encrypted-only no-op rewrote data");
            Check(unchangedCipher.SequenceEqual(File.ReadAllBytes(accountOnly.Path)), "No-op replaced encrypted bytes");

            var native = new List<object>();
            if (chrome is not null)
            {
                var real = MakeStore(Path.Combine(root, "chrome"));
                var profile = Directory.GetParent(Path.GetDirectoryName(real.Path)!)!.FullName;
                var backup = Path.Combine(root, "chrome-backups");
                Transaction(backup, "1.0.0").Execute([real], BookmarkOperation.InstallOrRepair, Now);
                // Negative control: the previous installer changed only clear JSON.
                var oldMutation = Editor("2.0.0").Mutate(File.ReadAllText(real.Path), BookmarkOperation.InstallOrRepair, Now);
                File.WriteAllText(real.Path, oldMutation.Json, new UTF8Encoding(false));
                await Launch(chrome, profile);
                Check(Version(real.Path) == "1.0.0", "Native negative control did not reproduce revert");
                native.Add(new { step = "old-clear-only", installed = "2.0.0", after_restart = Version(real.Path) });
                Transaction(backup, "2.0.0").Execute([real], BookmarkOperation.InstallOrRepair, Now.AddSeconds(1));
                for (var round = 1; round <= 2; round++)
                {
                    await Launch(chrome, profile);
                    using var c = ChromeBookmarkEncryption.Open(real.Path);
                    Check(Version(real.Path) == "2.0.0", "Native restart reverted updated version");
                    Check(c.Decrypt(File.ReadAllBytes(ChromeBookmarkEncryption.CompanionPath(real.Path)!)).SequenceEqual(File.ReadAllBytes(real.Path)), "Native pair is inconsistent");
                    native.Add(new { step = "paired-update", round, after_restart = Version(real.Path) });
                }
                await Launch(chrome, profile, "write_only_encrypted_read_prefer_encrypted");
                Check(!File.Exists(real.Path), "Native encrypted-only stage did not remove clear file");
                var onlyStore = ChromeProfileDiscovery.Discover(profile).Single().Stores.Single();
                Transaction(backup, "3.0.0").Execute([onlyStore], BookmarkOperation.InstallOrRepair, Now.AddMinutes(2));
                for (var round = 1; round <= 2; round++) {
                    await Launch(chrome, profile, "write_only_encrypted_read_prefer_encrypted");
                    Check(Version(onlyStore.Path) == "3.0.0" && !File.Exists(real.Path), "Native encrypted-only restart lost the installed version");
                    native.Add(new { step = "encrypted-only-update", round, after_restart = Version(onlyStore.Path) });
                }
            }
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, assertions = checks, real_user_profile_writes = 0, chrome_version = chrome is null ? null : FileVersionInfo.GetVersionInfo(chrome).FileVersion, native }));
            passed = true;
        }
        finally
        {
            if (passed && Path.GetDirectoryName(Path.GetFullPath(root)) == Path.GetFullPath(parent)
                && (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0) Directory.Delete(root, true);
            else Console.WriteLine("Retained owned fixture: " + root);
        }
    }

    private static BookmarkTestFileEditor Editor(string version)
    {
        var url = "javascript:void('fixture-" + version + "')";
        var definition = new BookmarkDefinition("candidate-test-03-1", "Gemini", "Gemini · " + version, "Gemini · " + version, version, "fixture.min.js", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant(), url.Length, url.Length, url);
        return new(new BookmarkPackage("cloudig/bookmark-package", "1.0.0", version, [definition]));
    }
    private static BookmarkTransaction Transaction(string backup, string version) => new(Editor(version), backup);
    private static string Version(string path) => JsonNode.Parse(ChromeProfileDiscovery.ReadBookmarkJson(path))!["roots"]!["bookmark_bar"]!["children"]![0]!["children"]![0]!["meta_info"]!["cloudig_test_version"]!.GetValue<string>();

    private static BookmarkStore MakeStore(string userData, bool encrypted = true, string fileName = "Bookmarks")
    {
        var profile = Path.Combine(userData, "Default"); Directory.CreateDirectory(profile);
        var roots = new JsonObject(); var id = 0;
        foreach (var name in new[] { "bookmark_bar", "other", "synced" })
            roots[name] = new JsonObject { ["id"] = (++id).ToString(), ["guid"] = id switch { 1 => "00000000-0000-4000-a000-000000000002", 2 => "00000000-0000-4000-a000-000000000003", _ => "00000000-0000-4000-a000-000000000004" }, ["name"] = name, ["type"] = "folder", ["children"] = new JsonArray(), ["date_added"] = "0", ["date_modified"] = "0" };
        var doc = new JsonObject { ["version"] = 1, ["roots"] = roots };
        var sums = ChromeBookmarkChecksums.Compute(doc); doc["checksum"] = sums.Md5; doc["checksum_sha256"] = sums.Sha256;
        var bytes = Encoding.UTF8.GetBytes(doc.ToJsonString());
        var path = Path.Combine(profile, fileName); File.WriteAllBytes(path, bytes);
        if (encrypted)
        {
            var key = RandomNumberGenerator.GetBytes(32);
            try
            {
                var state = new JsonObject { ["os_crypt"] = new JsonObject { ["encrypted_key"] = Convert.ToBase64String([.. "DPAPI"u8, .. Protect(key)]) } };
                File.WriteAllText(Path.Combine(userData, "Local State"), state.ToJsonString(), new UTF8Encoding(false));
                using var cipher = new ChromeBookmarkEncryption(key);
                File.WriteAllBytes(ChromeBookmarkEncryption.CompanionPath(path)!, cipher.Encrypt(bytes));
            }
            finally { CryptographicOperations.ZeroMemory(key); }
        }
        return new("Default", "Isolated fixture", fileName == "Bookmarks" ? "local" : "account", path);
    }

    private static async Task Launch(string chrome, string profile, string stage = "write_both_read_prefer_encrypted")
    {
        var start = new ProcessStartInfo(chrome) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        var temp = Path.Combine(profile, "temp"); Directory.CreateDirectory(temp);
        start.Environment["TEMP"] = temp; start.Environment["TMP"] = temp;
        foreach (var value in new[] { "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--user-data-dir=" + profile, "--disk-cache-dir=" + Path.Combine(profile, "cache"), "--crash-dumps-dir=" + temp, "--enable-features=EncryptBookmarks:stage/" + stage, "--virtual-time-budget=6000", "--timeout=10000", "--dump-dom", "about:blank" }) start.ArgumentList.Add(value);
        using var process = Process.Start(start) ?? throw new IOException("Isolated Chrome did not start");
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(25)); }
        finally { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } }
        await stdout; await stderr;
        if (process.ExitCode != 0) throw new IOException("Isolated Chrome failed: " + process.ExitCode);
    }

    // Wrap only this test's newly generated random key with the current Windows user.
    private static byte[] Protect(byte[] key)
    {
        var input = new Blob { Length = key.Length, Data = Marshal.AllocHGlobal(key.Length) }; Blob output = default;
        try
        {
            Marshal.Copy(key, 0, input.Data, key.Length);
            if (!CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var bytes = new byte[output.Length]; Marshal.Copy(output.Data, bytes, 0, bytes.Length); return bytes;
        }
        finally { for (var i = 0; i < key.Length; i++) Marshal.WriteByte(input.Data, i, 0); Marshal.FreeHGlobal(input.Data); if (output.Data != IntPtr.Zero) LocalFree(output.Data); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
