using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public sealed record WebBridgeRequest(string Request, string Command, JsonElement Payload);

public sealed class BridgePolicy
{
    public const string Protocol = "cloudig/web-bridge/1.0.0";
    public const string AppOrigin = "https://cloudig.local";
    public const string RuntimeOrigin = "https://cloudig-runtime.local";
    public const string WorkOrigin = "https://cloudig-work.invalid";
    private const int MaximumMessageBytes = 65_536;
    private const int MaximumNodes = 4_000;
    private static readonly Regex RequestId = new("^w_[A-Za-z0-9_-]{1,62}$", RegexOptions.CultureInvariant);
    private static readonly Regex RuntimePath = new("^/v_[A-Za-z0-9_-]{43}/(?:pages/p_[A-Za-z0-9_-]{43}\\.json|assets/r_[A-Za-z0-9_-]{43}\\.(?:png|jpg|gif|webp|svg|pdf|txt|bin))$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly HashSet<string> Commands = new(StringComparer.Ordinal)
    {
        "engine.handshake",
        "library.preferences.query",
        "library.preferences.commit",
        "identity.query",
        "identity.commit",
        "identity.avatar.resolve",
        "identity.avatar.preview",
        "indexes.rebuild",
        "archiver.sources.query",
        "archiver.sources.select",
        "archiver.source.dismissMissing",
        "archiver.claude.index",
        "archiver.claude.records.query",
        "archiver.claude.extract.preview",
        "archiver.claude.extract.commit",
        "source.import",
        "archiver.parse.plan",
        "archiver.parse.retarget",
        "archiver.parse.items",
        "archiver.parse.commit",
        "reader.archives.query",
        "reader.search.query",
        "reader.search.open",
        "reader.directory.create",
        "reader.directory.rename",
        "reader.directory.delete",
        "reader.archive.move",
        "reader.archive.archive",
        "reader.archive.restore",
        "reader.archive.exportMarkdown",
        "reader.archive.markdown.messages",
        "reader.archive.markdown.select",
        "reader.archive.markdown.releaseSelection",
        "reader.archive.info.query",
        "reader.archive.info.preview",
        "reader.archive.info.commit",
        "reader.archive.identity.query",
        "reader.archive.identity.commit",
        "time.cover.query",
        "time.route.resolve",
        "time.order.commit",
        "time.nodes.children",
        "time.sovereign.query",
        "time.endpoint.preview",
        "time.range.preview",
        "time.editor.query",
        "time.editor.preview",
        "time.editor.selection.preview",
        "time.editor.commit",
        "time.delete.preview",
        "time.delete.commit",
        "systemLog.list",
        "systemLog.delete",
        "systemLog.clear",
        "systemLog.reveal",
        "reader.view.open",
        "reader.view.page",
        "reader.position.query",
        "reader.position.save",
        "reader.resource.materialize",
        "reader.identity.resolve",
        "reader.view.close",
        "request.cancel",
        "shell.openExternal",
        "shell.checkUpdates",
        "shell.checkStartupUpdate",
        "shell.update.prepare",
        "shell.update.install",
        "shell.example.open",
        "shell.example.download",
        "reader.example.open",
        "shell.openManagedFolder",
        "shell.saveResource",
        "shell.copyMarkdown",
        "shell.pickSource",
        "shell.pickIdentityAvatar",
        "shell.discardIdentityAvatar",
        "shell.recycleArchive",
        "shell.bookmarks.query",
        "shell.bookmarks.target.query",
        "shell.bookmarks.target.save",
        "shell.bookmarks.copy",
        "shell.bookmarks.install",
        "shell.bookmarks.remove",
        "shell.library.info",
        "shell.libraryMove.plan",
        "shell.libraryMove.commit",
        "shell.surface",
        "shell.loading"
    };

    public bool IsTrustedSource(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && uri.Host.Equals("cloudig.local", StringComparison.OrdinalIgnoreCase)
            && uri.Port == 443;
    }

    public bool IsAllowedTopLevelNavigation(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && IsTrustedSource(uri.GetLeftPart(UriPartial.Authority))
            && uri.AbsolutePath.Equals("/index.html", StringComparison.Ordinal);
    }

    public bool IsAllowedFrameNavigation(string? value)
    {
        if (value is "about:blank" or "about:srcdoc") return true;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0) return false;
        return uri.Host == "cloudig.local" && uri.AbsolutePath == "/runtime/mermaid-frame.html"
            || uri.Host == "cloudig-work.invalid" && uri.AbsolutePath == "/runtime/interactive-frame.html"
            || uri.Host == "cloudig-map.local" && uri.AbsolutePath == "/runtime/map-frame.html";
    }

    public static bool IsExternalHttp(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            && !uri.Host.Equals("cloudig.local", StringComparison.OrdinalIgnoreCase)
            && !uri.Host.Equals("cloudig-runtime.local", StringComparison.OrdinalIgnoreCase)
            && !uri.Host.Equals("cloudig-work.invalid", StringComparison.OrdinalIgnoreCase)
            && !uri.Host.Equals("cloudig-map.local", StringComparison.OrdinalIgnoreCase);
    }

    public static Uri RuntimeUri(string virtualPath)
    {
        if (!RuntimePath.IsMatch(virtualPath)) throw new ArgumentException("Runtime capability path is invalid.", nameof(virtualPath));
        return new Uri($"{RuntimeOrigin}{virtualPath}", UriKind.Absolute);
    }

    public WebBridgeRequest Parse(string source, string json)
    {
        if (!IsAllowedTopLevelNavigation(source)) throw new InvalidDataException("Web message source is not trusted.");
        if (System.Text.Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes) throw new InvalidDataException("Web message exceeds its bound.");
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Web message must be an object.");
        var keys = root.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        var expected = new[] { "command", "payload", "protocol", "request" };
        if (!keys.SequenceEqual(expected, StringComparer.Ordinal)) throw new InvalidDataException("Web message envelope is invalid.");
        if (root.GetProperty("protocol").GetString() != Protocol) throw new InvalidDataException("Web message protocol is not supported.");
        var request = root.GetProperty("request").GetString();
        var command = root.GetProperty("command").GetString();
        var payload = root.GetProperty("payload");
        if (request is null || !RequestId.IsMatch(request)) throw new InvalidDataException("Web request ID is invalid.");
        if (command is null || !Commands.Contains(command)) throw new InvalidDataException("Web command is not allowlisted.");
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Web payload must be an object.");
        ValidateValue(payload);
        return new WebBridgeRequest(request, command, payload.Clone());
    }

    public string? CorrelationId(string source, string json)
    {
        if (!IsAllowedTopLevelNavigation(source) || System.Text.Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes) return null;
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("protocol", out var protocol) || protocol.ValueKind != JsonValueKind.String || protocol.GetString() != Protocol
                || !root.TryGetProperty("request", out var request) || request.ValueKind != JsonValueKind.String) return null;
            var id = request.GetString();
            return id is not null && RequestId.IsMatch(id) ? id : null;
        }
        catch (JsonException) { return null; }
    }

    private static void ValidateValue(JsonElement root)
    {
        var stack = new Stack<(JsonElement Value, int Depth)>();
        stack.Push((root, 0));
        var nodes = 0;
        while (stack.Count > 0)
        {
            var (value, depth) = stack.Pop();
            nodes++;
            if (nodes > MaximumNodes || depth > 32) throw new InvalidDataException("Web payload is too complex.");
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in value.EnumerateObject())
                {
                    if (property.Name is "data_base64" or "__proto__" or "constructor" or "prototype") throw new InvalidDataException("Web payload contains a forbidden field.");
                    stack.Push((property.Value, depth + 1));
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray()) stack.Push((item, depth + 1));
            }
            else if (value.ValueKind is JsonValueKind.Undefined)
            {
                throw new InvalidDataException("Web payload contains an invalid JSON value.");
            }
        }
    }

}
