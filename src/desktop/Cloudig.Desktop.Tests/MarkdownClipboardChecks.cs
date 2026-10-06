using System.Security.Cryptography;
using System.Text;
using Cloudig.Desktop.Core;

internal static class MarkdownClipboardChecks
{
    public static async Task RunAsync(string parent)
    {
        parent = Path.GetFullPath(parent);
        var boundary = Path.GetFullPath("tests/private") + Path.DirectorySeparatorChar;
        if (!parent.StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Clipboard tests must stay in project private tests.");
        Directory.CreateDirectory(parent);
        var root = Path.Combine(parent, "clipboard-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(root, "cache", "Engine", "s_" + new string('a', 32), "payload.md");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!); var passed = false;
        try
        {
            var text = string.Concat(Enumerable.Repeat("# Markdown\n正文与公式 $x$\n", 75000));
            var bytes = Encoding.UTF8.GetBytes(text); await File.WriteAllBytesAsync(file, bytes);
            var hash = Convert.ToHexString(SHA256.HashData(bytes));
            if (await MarkdownClipboardPayload.ReadAsync(root, file, bytes.Length, hash, default) != text) throw new Exception("Clipboard transfer changed Markdown.");
            await Reject(() => MarkdownClipboardPayload.ReadAsync(root, file, bytes.Length, new string('0', 64), default));
            await Reject(() => MarkdownClipboardPayload.ReadAsync(root, file, bytes.Length + 1, hash, default));
            await Reject(() => MarkdownClipboardPayload.ReadAsync(root, Path.Combine(root, "Conversations", "other.md"), 0, hash, default));
            await Reject(() => MarkdownClipboardPayload.ReadAsync(root, file, MarkdownClipboardPayload.MaximumBytes + 1, hash, default));
            Console.WriteLine("PASS Markdown clipboard: >1MiB exact text, hash/size/path/budget checks; Windows clipboard untouched."); passed = true;
        }
        finally
        {
            if (passed && Directory.GetParent(root)!.FullName.Equals(parent, StringComparison.OrdinalIgnoreCase) && (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0) Directory.Delete(root, true);
            else if (!passed) Console.Error.WriteLine("Retained clipboard test: " + root);
        }
    }
    private static async Task Reject(Func<Task<string>> action) { try { await action(); } catch (Exception error) when (error is IOException or InvalidDataException) { return; } throw new Exception("Invalid clipboard receipt was accepted."); }
}
