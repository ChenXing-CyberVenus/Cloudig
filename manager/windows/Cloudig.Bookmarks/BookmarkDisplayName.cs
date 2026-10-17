using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

// Chrome bookmark names are bilingual and do not depend on the app UI language.
internal static partial class BookmarkDisplayName
{
    internal static string Format(string platform, string profile, string version)
    {
        var (chinese, english) = profile switch
        {
            BookmarkProfiles.Light => ("轻装", "Light"),
            BookmarkProfiles.Full => ("全量", "Full"),
            BookmarkProfiles.AllBranches => ("整树", "Tree"),
            _ => throw new InvalidDataException($"Unknown bookmark display profile: {profile}")
        };
        var numeric = NumericVersion().Match(version.Trim());
        if (!numeric.Success) throw new InvalidDataException($"Invalid bookmark display version: {version}");
        return $"{platform}（{chinese}）· {numeric.Groups[1].Value}-{english} · Cloudig";
    }

    [GeneratedRegex(@"^([0-9]+(?:\.[0-9]+)*)(?:[-+].*)?$", RegexOptions.CultureInvariant)]
    private static partial Regex NumericVersion();
}
