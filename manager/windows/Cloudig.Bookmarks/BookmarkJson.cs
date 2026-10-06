using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

internal static class BookmarkJson
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static JsonObject ParseObject(string json)
    {
        try
        {
            return JsonNode.Parse(json, documentOptions: new JsonDocumentOptions
            {
                MaxDepth = 256,
                CommentHandling = JsonCommentHandling.Disallow,
                AllowTrailingCommas = false
            })?.AsObject() ?? throw new InvalidDataException("Chrome Bookmarks root must be an object.");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("Chrome Bookmarks is not valid JSON.", error);
        }
    }

    public static JsonObject RequiredObject(JsonObject parent, string property)
    {
        return parent[property] as JsonObject
               ?? throw new InvalidDataException($"Chrome Bookmarks requires object {property}.");
    }

    public static JsonArray RequiredArray(JsonObject parent, string property)
    {
        return parent[property] as JsonArray
               ?? throw new InvalidDataException($"Chrome Bookmarks requires array {property}.");
    }

    public static string RequiredString(JsonObject parent, string property)
    {
        var value = OptionalString(parent, property);
        return value ?? throw new InvalidDataException($"Chrome Bookmarks requires string {property}.");
    }

    public static string? OptionalString(JsonObject parent, string property)
    {
        if (parent[property] is not JsonValue value || !value.TryGetValue<string>(out var text)) return null;
        return text;
    }

    public static byte[] Utf8(string value) => new UTF8Encoding(false, true).GetBytes(value);

    public static string Serialize(JsonObject document) => document.ToJsonString(SerializerOptions) + Environment.NewLine;
}
