using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

public static partial class BookmarkTestDirectoryLoader
{
    private const int MaximumCharacters = 480 * 1024;

    public static BookmarkPackage Load(string directory)
    {
        var root = Path.GetFullPath(directory);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException($"书签测试目录不存在：{root}");

        var files = Directory.EnumerateFiles(root, "*.min.js", SearchOption.TopDirectoryOnly)
            .OrderBy(Path.GetFileName, StringComparer.Ordinal)
            .ToArray();
        if (files.Length == 0) throw new InvalidDataException("当前目录没有可安装的 .min.js 书签。");

        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenSlots = new HashSet<string>(StringComparer.Ordinal);
        var bookmarks = new List<BookmarkDefinition>(files.Length);
        using var aggregate = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var path in files)
        {
            var fileName = Path.GetFileName(path);
            if (!seenNames.Add(fileName)) throw new InvalidDataException($"书签文件名大小写冲突：{fileName}");
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException($"书签测试目录不接受链接文件：{fileName}");
            }

            var match = AcceptanceName().Match(fileName);
            if (!match.Success)
            {
                throw new InvalidDataException($"书签文件名不符合验收集合规则：{fileName}");
            }
            var slot = match.Groups["slot"].Value;
            if (!seenSlots.Add(slot)) throw new InvalidDataException($"书签验收槽位重复：{slot}");

            var bytes = File.ReadAllBytes(path);
            var url = new UTF8Encoding(false, true).GetString(bytes);
            if (!url.StartsWith("javascript:", StringComparison.Ordinal)
                || url.Contains('\r')
                || url.Contains('\n')
                || url.Length > MaximumCharacters)
            {
                throw new InvalidDataException($"书签不是合格的严格单行 javascript: URL：{fileName}");
            }

            aggregate.AppendData(Encoding.UTF8.GetBytes(fileName));
            aggregate.AppendData([0]);
            aggregate.AppendData(bytes);
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            var rawLabel = match.Groups["label"].Value;
            var label = rawLabel.Replace('_', ' ');
            var version = match.Groups["version"].Value;
            var separator = rawLabel.LastIndexOf('_');
            if (separator < 1) throw new InvalidDataException($"书签文件名缺少平台与档位：{fileName}");
            var profile = version.EndsWith("-light", StringComparison.Ordinal) ? BookmarkProfiles.Light
                : version.EndsWith("-full", StringComparison.Ordinal) ? BookmarkProfiles.Full : BookmarkProfiles.AllBranches;
            var title = BookmarkDisplayName.Format(rawLabel[..separator].Replace('_', ' '), profile, version);
            bookmarks.Add(new BookmarkDefinition(
                $"candidate-test-{slot}",
                label,
                title,
                title,
                version,
                fileName,
                sha256,
                bytes.LongLength,
                url.Length,
                url));
        }

        var setVersion = Convert.ToHexString(aggregate.GetHashAndReset()).ToLowerInvariant();
        return new BookmarkPackage(
            "cloudig/bookmark-test-directory",
            "0.1.0",
            setVersion,
            bookmarks);
    }

    [GeneratedRegex(
        @"^(?<slot>[0-9]{2}-[123])_(?<label>.+)_(?<version>[0-9]+\.[0-9]+\.[0-9]+-(?:light|full|all-branches))\.min\.js$",
        RegexOptions.CultureInvariant)]
    private static partial Regex AcceptanceName();
}
