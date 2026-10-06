using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public static class ChromeBookmarkChecksums
{
    private static readonly string[] RootOrder = ["bookmark_bar", "other", "synced"];

    public static (string Md5, string Sha256) Compute(JsonObject document)
    {
        var roots = BookmarkJson.RequiredObject(document, "roots");
        using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        using var sha256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var count = 0;
        foreach (var rootName in RootOrder)
        {
            var root = BookmarkJson.RequiredObject(roots, rootName);
            UpdateNode(root, md5, sha256, depth: 0, ref count);
        }
        return (
            Convert.ToHexString(md5.GetHashAndReset()).ToLowerInvariant(),
            Convert.ToHexString(sha256.GetHashAndReset()).ToLowerInvariant());
    }

    public static void AssertValid(JsonObject document)
    {
        var (md5, sha256) = Compute(document);
        var storedMd5 = BookmarkJson.OptionalString(document, "checksum");
        var storedSha = BookmarkJson.OptionalString(document, "checksum_sha256");
        if (string.IsNullOrEmpty(storedMd5) && string.IsNullOrEmpty(storedSha))
        {
            throw new InvalidDataException("Chrome Bookmarks is missing both checksum and checksum_sha256.");
        }
        if (!string.IsNullOrEmpty(storedMd5) && !FixedHexEquals(storedMd5, md5))
        {
            throw new InvalidDataException("Chrome Bookmarks MD5 checksum does not match; Chrome may be writing or the file may be damaged.");
        }
        if (!string.IsNullOrEmpty(storedSha) && !FixedHexEquals(storedSha, sha256))
        {
            throw new InvalidDataException("Chrome Bookmarks SHA-256 checksum does not match; Chrome may be writing or the file may be damaged.");
        }
    }

    public static bool FixedHexEquals(string left, string right)
    {
        if (left.Length != right.Length) return false;
        var leftBytes = Encoding.ASCII.GetBytes(left.ToLowerInvariant());
        var rightBytes = Encoding.ASCII.GetBytes(right.ToLowerInvariant());
        return CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static void UpdateNode(
        JsonObject node,
        IncrementalHash md5,
        IncrementalHash sha256,
        int depth,
        ref int count)
    {
        if (depth > 256 || ++count > 1_000_000) throw new InvalidDataException("Chrome Bookmarks exceeds Cloudig safety limits.");
        var id = BookmarkJson.RequiredString(node, "id");
        var name = BookmarkJson.RequiredString(node, "name");
        var type = BookmarkJson.RequiredString(node, "type");
        var isUrl = type == "url";
        if (!isUrl && type != "folder") throw new InvalidDataException($"Unsupported Chrome bookmark node type: {type}");
        Append(md5, sha256, Encoding.UTF8.GetBytes(id));
        Append(md5, sha256, Encoding.Unicode.GetBytes(name));
        Append(md5, sha256, Encoding.UTF8.GetBytes(isUrl ? "url" : "folder"));
        if (isUrl)
        {
            Append(md5, sha256, Encoding.UTF8.GetBytes(BookmarkJson.RequiredString(node, "url")));
            return;
        }
        foreach (var child in BookmarkJson.RequiredArray(node, "children"))
        {
            if (child is not JsonObject childObject) throw new InvalidDataException("Chrome bookmark children must be objects.");
            UpdateNode(childObject, md5, sha256, depth + 1, ref count);
        }
    }

    private static void Append(IncrementalHash first, IncrementalHash second, byte[] bytes)
    {
        first.AppendData(bytes);
        second.AppendData(bytes);
    }
}
