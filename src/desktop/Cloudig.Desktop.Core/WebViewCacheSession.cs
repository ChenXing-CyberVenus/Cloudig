using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

// PID reuse is not an exit proof. Unknown ownership is retained, not guessed.
public sealed class WebViewCacheSession
{
    private sealed record Owner(string Schema, int HostPid, long HostStarted, int? BrowserPid, long? BrowserStarted, bool BrowserStartedKnown);
    private const string Schema = "cloudig/webview-cache/1.0.0";
    private readonly string _directory;
    private Owner _owner;
    public string ProfileRoot => Path.Combine(_directory, "profile");

    private WebViewCacheSession(string directory, Owner owner) { _directory = directory; _owner = owner; }

    public static WebViewCacheSession Create(string root)
    {
        Directory.CreateDirectory(root);
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("WebView cache root is a reparse point.");
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            if (!Regex.IsMatch(Path.GetFileName(directory), "^w_[0-9a-f]{32}$", RegexOptions.CultureInvariant)) continue;
            try
            {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
                var owner = JsonSerializer.Deserialize<Owner>(File.ReadAllText(Path.Combine(directory, "owner.json")));
                if (owner is not { Schema: Schema, BrowserStartedKnown: true } || !Exited(owner.HostPid, owner.HostStarted)) continue;
                if (owner.BrowserPid is { } pid && (owner.BrowserStarted is not { } ticks || !Exited(pid, ticks))) continue;
                RemovePlainTree(directory);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
        }
        using var process = Process.GetCurrentProcess();
        var current = new Owner(Schema, process.Id, process.StartTime.ToUniversalTime().Ticks, null, null, false);
        var target = Path.Combine(root, $"w_{Guid.NewGuid():N}");
        Directory.CreateDirectory(target);
        var session = new WebViewCacheSession(target, current);
        session.WriteOwner();
        return session;
    }

    public void RegisterBrowser(int pid)
    {
        using var process = Process.GetProcessById(pid);
        _owner = _owner with { BrowserPid = pid, BrowserStarted = process.StartTime.ToUniversalTime().Ticks, BrowserStartedKnown = true };
        WriteOwner();
    }

    public bool RemoveAfterExit()
    {
        if (!_owner.BrowserStartedKnown && Directory.Exists(ProfileRoot)) return false;
        if (_owner.BrowserPid is { } pid && (_owner.BrowserStarted is not { } ticks || !Exited(pid, ticks))) return false;
        RemovePlainTree(_directory);
        return true;
    }

    public (long Bytes, int Files) Footprint()
    {
        long bytes = 0;
        int files = 0;
        if (Directory.Exists(ProfileRoot))
            foreach (var file in Directory.EnumerateFiles(ProfileRoot, "*", SearchOption.AllDirectories)) { bytes += new FileInfo(file).Length; files++; }
        return (bytes, files);
    }

    private void WriteOwner()
    {
        var temporary = Path.Combine(_directory, "owner.next");
        File.WriteAllText(temporary, JsonSerializer.Serialize(_owner));
        File.Move(temporary, Path.Combine(_directory, "owner.json"), true);
    }

    private static bool Exited(int pid, long start)
    {
        try { using var process = Process.GetProcessById(pid); return process.HasExited || process.StartTime.ToUniversalTime().Ticks != start; }
        catch (ArgumentException) { return true; }
        catch (InvalidOperationException) { return true; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    private static void RemovePlainTree(string directory)
    {
        if (!Directory.Exists(directory)) return;
        static void Check(string current)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Cache contains a reparse point.");
            if (Directory.Exists(current)) foreach (var entry in Directory.EnumerateFileSystemEntries(current)) Check(entry);
        }
        Check(directory);
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            if (Path.GetFileName(entry) == "owner.json") continue;
            if (Directory.Exists(entry)) Directory.Delete(entry, true); else File.Delete(entry);
        }
        File.Delete(Path.Combine(directory, "owner.json"));
        Directory.Delete(directory);
    }
}
