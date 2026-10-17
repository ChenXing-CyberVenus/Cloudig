using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

public sealed class BookmarkChangelog
{
    private const string ProfileNamePattern = @"轻装（Light）|轻量（Light）|全量（Full）|整树（Tree）|Light|Full|Tree|整树版";
    private static readonly Regex ProfileVersionPattern = new(
        $@"(?<profile>{ProfileNamePattern})(?:\s*[/／、]\s*(?<profile>{ProfileNamePattern}))*\s*`?(?<version>\d+\.\d+\.\d+)`?",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex CoreVersionPattern = new(
        @"^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-[a-z0-9-]+)?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private readonly IReadOnlyList<Entry> _entries;

    internal static bool IsNewerVersion(string installed, string bundled) =>
        TryParseCoreVersion(installed, out var left)
        && TryParseCoreVersion(bundled, out var right)
        && left.CompareTo(right) > 0;

    private BookmarkChangelog(IReadOnlyList<Entry> entries)
    {
        _entries = entries;
    }

    public static BookmarkChangelog Empty { get; } = new(Array.Empty<Entry>());

    public static async Task<BookmarkChangelog> LoadAsync(
        string path,
        IReadOnlyList<BookmarkPlatform> platforms,
        CancellationToken cancellationToken = default)
    {
        var bytes = await File.ReadAllBytesAsync(Path.GetFullPath(path), cancellationToken);
        var markdown = new UTF8Encoding(false, true).GetString(bytes);
        return Parse(markdown, platforms);
    }

    public static BookmarkChangelog Parse(
        string markdown,
        IReadOnlyList<BookmarkPlatform> platforms)
    {
        ArgumentNullException.ThrowIfNull(markdown);
        ArgumentNullException.ThrowIfNull(platforms);
        if (platforms.Count == 0) throw new InvalidDataException("Bookmark changelog has no platform catalog.");

        var rows = ParseTable(markdown);
        var entries = new List<Entry>();
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (var cells in rows)
        {
            if (!DateOnly.TryParseExact(
                    cells[0],
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var date))
            {
                throw new InvalidDataException($"Bookmark changelog has an invalid date: {cells[0]}");
            }

            // Accepted collection rows contain the same explicit per-platform
            // versions, preceded by a set-level acceptance note. Do not treat
            // that note as a platform or discard every other upgrade row.
            var descriptors = Regex.Replace(cells[1], @"^集合\s*`?\d{4}\.\d{2}\.\d{2}\.\d+`?\s*全部\d+轨验收[；;]\s*本次升级[：:]\s*", "");
            descriptors = Regex.Replace(descriptors, @"[（(]Light=(?:轻装|轻量)[，,]\s*Full=全量[，,]\s*Tree=整树[）)]。?$", "");
            foreach (var descriptor in descriptors.Split(['；', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var named = platforms.SelectMany(item => new[] { item.Label, item.Id, item.Id == "yuanbao" ? "元宝" : item.Label }
                        .Distinct(StringComparer.OrdinalIgnoreCase).Select(name => new { Platform = item, Name = name }))
                    .OrderByDescending(item => item.Name.Length)
                    .FirstOrDefault(item => descriptor.StartsWith($"{item.Name} ", StringComparison.OrdinalIgnoreCase));
                if (named is null)
                {
                    throw new InvalidDataException($"Bookmark changelog names an unknown platform: {cells[1]}");
                }

                var platform = named.Platform;
                var versionText = descriptor[named.Name.Length..].Trim();
                var matches = ProfileVersionPattern.Matches(versionText);
                if (matches.Count == 0)
                {
                    throw new InvalidDataException($"Bookmark changelog has no recognized profile version: {cells[1]}");
                }

                var remainder = ProfileVersionPattern.Replace(versionText, string.Empty)
                    .Replace("、", string.Empty, StringComparison.Ordinal)
                    .Replace(",", string.Empty, StringComparison.Ordinal)
                    .Replace("/", string.Empty, StringComparison.Ordinal)
                    .Replace("／", string.Empty, StringComparison.Ordinal)
                    .Trim();
                if (remainder.Length != 0)
                {
                    throw new InvalidDataException($"Bookmark changelog has unrecognized profile text: {cells[1]}");
                }

                var summary = PlainMarkdownText(cells[2]);
                var reexport = PlainMarkdownText(cells[3]);
                if (summary.Length == 0 || reexport.Length == 0)
                {
                    throw new InvalidDataException("Bookmark changelog summary and re-export guidance cannot be empty.");
                }

                foreach (Match match in matches)
                {
                    foreach (Capture profileCapture in match.Groups["profile"].Captures)
                    {
                        var profile = NormalizeProfile(profileCapture.Value);
                        var version = match.Groups["version"].Value;
                        var semanticVersion = ParseCoreVersion(version);
                        var key = $"{platform.Id}\n{profile}\n{version}";
                        if (!unique.Add(key))
                        {
                            throw new InvalidDataException($"Bookmark changelog repeats {platform.Id} {profile} {version}.");
                        }

                        entries.Add(new Entry(
                            date,
                            platform.Id,
                            profile,
                            version,
                            semanticVersion,
                            summary,
                            reexport));
                    }
                }
            }
        }

        return new BookmarkChangelog(entries);
    }

    public IReadOnlyList<BookmarkUpgradeNote> GetUpgradeNotes(
        string platformId,
        string profile,
        IEnumerable<string> installedVersions,
        string currentVersion)
    {
        var current = ParseCoreVersion(currentVersion);
        var installed = installedVersions
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .Select(value => TryParseCoreVersion(value, out var version)
                ? new InstalledVersion(value, version)
                : null)
            .Where(item => item is not null)
            .Select(item => item!)
            .ToArray();
        if (installed.Length == 0) return Array.Empty<BookmarkUpgradeNote>();

        return _entries
            .Where(entry => entry.PlatformId.Equals(platformId, StringComparison.Ordinal)
                            && entry.Profile.Equals(profile, StringComparison.Ordinal)
                            && entry.SemanticVersion.CompareTo(current) <= 0)
            .Select(entry => new
            {
                Entry = entry,
                From = installed
                    .Where(item => item.SemanticVersion.CompareTo(entry.SemanticVersion) < 0)
                    .Select(item => item.Text)
                    .OrderBy(item => ParseCoreVersion(item))
                    .ToArray()
            })
            .Where(item => item.From.Length > 0)
            .OrderBy(item => item.Entry.Date)
            .ThenBy(item => item.Entry.SemanticVersion)
            .Select(item => new BookmarkUpgradeNote(
                item.Entry.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                item.Entry.PlatformId,
                item.Entry.Profile,
                item.Entry.Version,
                item.From,
                item.Entry.Summary,
                item.Entry.ReexportGuidance))
            .ToArray();
    }

    private static IReadOnlyList<IReadOnlyList<string>> ParseTable(string markdown)
    {
        var result = new List<IReadOnlyList<string>>();
        var lines = markdown.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var headerFound = false;
        var separatorFound = false;
        foreach (var line in lines)
        {
            if (!line.TrimStart().StartsWith('|'))
            {
                if (separatorFound && result.Count > 0) break;
                continue;
            }

            var cells = SplitMarkdownRow(line);
            if (!headerFound)
            {
                if (cells.SequenceEqual(["日期", "平台与版本", "本次升级", "旧 HTML 是否重下"]))
                {
                    headerFound = true;
                }
                continue;
            }

            if (!separatorFound)
            {
                if (cells.Count != 4 || cells.Any(cell => !Regex.IsMatch(cell, @"^:?-{3,}:?$")))
                {
                    throw new InvalidDataException("Bookmark changelog table separator is invalid.");
                }
                separatorFound = true;
                continue;
            }

            if (cells.Count != 4)
            {
                throw new InvalidDataException("Bookmark changelog row must contain four columns.");
            }
            result.Add(cells);
        }

        if (!headerFound || !separatorFound)
        {
            throw new InvalidDataException("Bookmark changelog table was not found.");
        }
        return result;
    }

    private static IReadOnlyList<string> SplitMarkdownRow(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length < 2 || trimmed[0] != '|' || trimmed[^1] != '|')
        {
            throw new InvalidDataException("Bookmark changelog table row is malformed.");
        }

        var cells = new List<string>();
        var cell = new StringBuilder();
        for (var index = 1; index < trimmed.Length - 1; index += 1)
        {
            var character = trimmed[index];
            if (character == '\\' && index + 1 < trimmed.Length - 1 && trimmed[index + 1] == '|')
            {
                cell.Append('|');
                index += 1;
                continue;
            }
            if (character == '|')
            {
                cells.Add(cell.ToString().Trim());
                cell.Clear();
                continue;
            }
            cell.Append(character);
        }
        cells.Add(cell.ToString().Trim());
        return cells;
    }

    private static string NormalizeProfile(string label) => label switch
    {
        "Light" => BookmarkProfiles.Light,
        "轻装（Light）" => BookmarkProfiles.Light,
        "轻量（Light）" => BookmarkProfiles.Light,
        "Full" => BookmarkProfiles.Full,
        "全量（Full）" => BookmarkProfiles.Full,
        "Tree" => BookmarkProfiles.AllBranches,
        "整树（Tree）" => BookmarkProfiles.AllBranches,
        "整树版" => BookmarkProfiles.AllBranches,
        _ => throw new InvalidDataException($"Bookmark changelog has an unknown profile label: {label}")
    };

    private static CoreVersion ParseCoreVersion(string value)
    {
        if (!TryParseCoreVersion(value, out var version))
        {
            throw new InvalidDataException($"Bookmark changelog cannot compare version: {value}");
        }
        return version;
    }

    private static bool TryParseCoreVersion(string value, out CoreVersion version)
    {
        var match = CoreVersionPattern.Match(value.Trim());
        if (!match.Success
            || !int.TryParse(match.Groups["major"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var major)
            || !int.TryParse(match.Groups["minor"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var minor)
            || !int.TryParse(match.Groups["patch"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var patch))
        {
            version = default;
            return false;
        }
        version = new CoreVersion(major, minor, patch);
        return true;
    }

    private static string PlainMarkdownText(string value) => value
        .Replace("**", string.Empty, StringComparison.Ordinal)
        .Replace("__", string.Empty, StringComparison.Ordinal)
        .Replace("`", string.Empty, StringComparison.Ordinal)
        .Trim();

    private sealed record Entry(
        DateOnly Date,
        string PlatformId,
        string Profile,
        string Version,
        CoreVersion SemanticVersion,
        string Summary,
        string ReexportGuidance);

    private sealed record InstalledVersion(string Text, CoreVersion SemanticVersion);

    private readonly record struct CoreVersion(int Major, int Minor, int Patch) : IComparable<CoreVersion>
    {
        public int CompareTo(CoreVersion other)
        {
            var major = Major.CompareTo(other.Major);
            if (major != 0) return major;
            var minor = Minor.CompareTo(other.Minor);
            return minor != 0 ? minor : Patch.CompareTo(other.Patch);
        }
    }
}
