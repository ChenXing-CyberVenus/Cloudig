using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public static class MarkdownClipboardPayload
{
    public const long MaximumBytes = 128L * 1024 * 1024;
    private static readonly Regex RelativeFile = new(@"^cache[/\\]Engine[/\\]s_[0-9a-f]{32}[/\\]payload\.md$", RegexOptions.CultureInvariant);

    // Receives only the Engine's native-only preparation receipt, never a webpage path.
    public static async Task<string> ReadAsync(string libraryRoot, string file, long bytes, string sha256, CancellationToken cancellationToken)
    {
        var root = Path.GetFullPath(libraryRoot);
        var target = Path.GetFullPath(file);
        if (!RelativeFile.IsMatch(Path.GetRelativePath(root, target)) || bytes < 0) throw new InvalidDataException("Invalid Markdown clipboard receipt.");
        if (bytes > MaximumBytes) throw new IOException("Markdown内容过大，请使用导出文件。 / Markdown is too large for the clipboard; export a file instead.");
        for (var current = target; !current.Equals(root, StringComparison.OrdinalIgnoreCase); current = Path.GetDirectoryName(current)!)
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Markdown clipboard path changed.");
        if (new FileInfo(target).Length != bytes) throw new InvalidDataException("Markdown clipboard size changed.");
        var content = await File.ReadAllBytesAsync(target, cancellationToken);
        if (content.LongLength != bytes || !Convert.ToHexString(SHA256.HashData(content)).Equals(sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Markdown clipboard content changed.");
        var text = new UTF8Encoding(false, true).GetString(content);
        if (text.Contains('\0')) throw new InvalidDataException("Markdown包含剪贴板不支持的空字符，请导出文件。 / Markdown contains a null character; export a file instead.");
        return text;
    }
}
