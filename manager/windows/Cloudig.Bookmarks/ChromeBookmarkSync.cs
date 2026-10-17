using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

// Matches Chromium M152 BookmarkModelMetadata / EntityMetadata. This is an
// offline edit of one local operation, never an implementation of server sync.
internal static class ChromeBookmarkSync
{
    private sealed record Node(long Id, string Guid, string? Parent, JsonObject Json, int Depth);
    private sealed record Entry(ChromeSyncMessage.Field Field, ChromeSyncMessage Record, ChromeSyncMessage Metadata);
    private static readonly string[] Roots = ["bookmark_bar", "other", "synced"];

    internal static BookmarkMutation Apply(string originalJson, BookmarkMutation mutation, DateTime utcNow)
    {
        var original = BookmarkJson.ParseObject(originalJson);
        var encoded = BookmarkJson.OptionalString(original, "sync_metadata");
        if (string.IsNullOrEmpty(encoded)) return mutation;
        var after = BookmarkJson.ParseObject(mutation.Json);
        byte[] syncBytes;
        try { syncBytes = Convert.FromBase64String(encoded); }
        catch (FormatException) { throw ChromeSyncMessage.Invalid("同步记录不是完整的Base64数据，请先让Chrome重新保存书签"); }
        var model = ChromeSyncMessage.Parse(syncBytes);
        var rawEntries = model.Fields(2).ToArray();
        // No initial sync has taken place: there is no tracker to patch.
        if (rawEntries.Length == 0)
        {
            if (model.Bytes(1) is { } emptyState && ChromeSyncMessage.Parse(emptyState).Number(9) is 3 or 4)
                throw ChromeSyncMessage.Invalid("同步记录缺少根目录，请先让Chrome重新保存书签");
            return mutation;
        }
        if (model.Bytes(1) is not { Length: > 0 } state || ChromeSyncMessage.Parse(state).Number(9) is not (3 or 4))
            throw ChromeSyncMessage.Invalid("同步尚未完成首次合并");
        var beforeNodes = Nodes(original);
        var afterNodes = Nodes(after);
        var beforeByGuid = beforeNodes.Values.ToDictionary(n => n.Guid, StringComparer.Ordinal);
        var afterByGuid = afterNodes.Values.ToDictionary(n => n.Guid, StringComparer.Ordinal);
        var entries = new Dictionary<long, Entry>();
        var tags = new HashSet<string>(StringComparer.Ordinal);
        var serverIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in rawEntries)
        {
            var record = ChromeSyncMessage.Parse(raw.Data);
            var metadata = ChromeSyncMessage.Parse(record.Bytes(2) ?? throw ChromeSyncMessage.Invalid("缺少节点同步记录"));
            var tag = metadata.Text(1);
            var serverId = metadata.Text(2);
            if (string.IsNullOrEmpty(tag) || string.IsNullOrEmpty(serverId) || !tags.Add(tag) || !serverIds.Add(serverId)
                || !metadata.Has(7) || metadata.Number(4) < metadata.Number(5) || metadata.Number(5) < 0)
                throw ChromeSyncMessage.Invalid("同步身份或修改序号不一致");
            if (metadata.Number(3) != 0)
            {
                if (record.Has(1)) throw ChromeSyncMessage.Invalid("删除记录仍占用本地节点");
                continue; // Preserve previous tombstones byte-for-byte, in order.
            }
            var id = record.Number(1, -1);
            if (!beforeNodes.TryGetValue(id, out var node) || !entries.TryAdd(id, new Entry(raw, record, metadata))
                || tag != ClientTag(node.Guid)) throw ChromeSyncMessage.Invalid("书签和同步身份不匹配");
            if (node.Json["type"]?.GetValue<string>() == "url" && !metadata.Has(12))
                throw ChromeSyncMessage.Invalid("缺少已有书签图标校验值");
        }

        bool InSelectedScope(Node node, Dictionary<string, Node> nodes)
        {
            var current = node;
            while (true)
            {
                if (current.Guid == mutation.ManagedFolderGuid)
                {
                    if (current.Id == node.Id) return true;
                    var rootMeta = current.Json["meta_info"] as JsonObject;
                    var nodeMeta = node.Json["meta_info"] as JsonObject;
                    if (nodeMeta is null) return false;
                    var test = rootMeta?["cloudig_test_folder"]?.GetValue<string>() == "1";
                    var owned = test ? nodeMeta["cloudig_test_managed"]?.GetValue<string>() == "1"
                        : nodeMeta["cloudig_managed"]?.GetValue<string>() == "1" || nodeMeta["ai_chat_archive_managed"]?.GetValue<string>() == "1";
                    var owner = rootMeta?["cloudig_installation_id"]?.GetValue<string>();
                    return owned && (string.IsNullOrEmpty(owner) || nodeMeta["cloudig_installation_id"]?.GetValue<string>() == owner);
                }
                if (current.Parent is null || !nodes.TryGetValue(current.Parent, out current!)) return false;
            }
        }
        // Do not repair somebody else's untracked bookmark as a side effect.
        foreach (var node in beforeNodes.Values.Where(n => !entries.ContainsKey(n.Id)))
            if (afterNodes.ContainsKey(node.Id) && !InSelectedScope(node, beforeByGuid))
                throw ChromeSyncMessage.Invalid("所选目录之外存在未同步登记的书签，请先让Chrome正常完成同步");

        var deleted = beforeNodes.Values.Where(n => !afterNodes.ContainsKey(n.Id)).OrderByDescending(n => n.Depth).ToArray();
        var changed = false;
        var now = new DateTimeOffset(utcNow.ToUniversalTime()).ToUnixTimeMilliseconds();
        foreach (var node in deleted)
        {
            if (!entries.Remove(node.Id, out var entry)) continue;
            Bump(entry.Metadata);
            entry.Metadata.SetNumber(3, 1);
            entry.Metadata.SetNumber(8, now);
            foreach (var field in new[] { 9, 11, 12, 13 }) entry.Metadata.Remove(field);
            // Do not impersonate a Chromium build in deleted_by_version.
            entry.Record.Remove(1);
            entry.Record.SetBytes(2, entry.Metadata.Encode());
            model.RemoveRaw(entry.Field);
            model.AddBytes(2, entry.Record.Encode());
            changed = true;
        }

        var positioned = new HashSet<long>();
        var needsPosition = afterNodes.Values.Where(node => !entries.ContainsKey(node.Id)
            || beforeNodes.GetValueOrDefault(node.Id)?.Parent != node.Parent
            || (node.Guid == mutation.ManagedFolderGuid && OrderChanged(node, beforeNodes, afterNodes))).Select(n => n.Id).ToHashSet();
        foreach (var node in afterNodes.Values)
        {
            var added = !entries.TryGetValue(node.Id, out var entry);
            var previous = beforeNodes.GetValueOrDefault(node.Id);
            var moved = needsPosition.Contains(node.Id);
            if (!added && !moved && previous is not null && SameSpecifics(previous, node))
            {
                // Earlier offline installers may have left our own tracked
                // nodes with stale hashes. Repair only the selected ownership.
                if (!InSelectedScope(node, afterByGuid) || entry!.Metadata.Fixed32(12) != 0) continue;
                var currentPosition = entry.Metadata.Bytes(11) ?? throw ChromeSyncMessage.Invalid("缺少节点排序值");
                if (entry.Metadata.Text(9) == Hash(Specifics(node.Json, node.Parent!, currentPosition))) continue;
            }
            if (node.Parent is null) throw ChromeSyncMessage.Invalid("不能修改永久根节点的同步内容");
            if (previous is not null && previous.Guid != node.Guid) throw ChromeSyncMessage.Invalid("不能重用另一书签的本地编号");
            var metadata = entry?.Metadata ?? NewMetadata(node, now);
            if (metadata.Fixed32(12) != 0 && node.Json["type"]?.GetValue<string>() == "url")
                throw ChromeSyncMessage.Invalid("该书签包含独立图标数据，当前不能保真更新它的同步摘要");
            var position = metadata.Bytes(11);
            if (moved)
            {
                var siblings = Children(afterByGuid[node.Parent]).ToArray();
                var index = Array.IndexOf(siblings, node.Id);
                byte[]? Neighbor(IEnumerable<long> ids)
                {
                    foreach (var id in ids)
                        if ((!needsPosition.Contains(id) || positioned.Contains(id)) && entries.TryGetValue(id, out var known))
                            return ChromeUniquePosition.Read(known.Metadata.Bytes(11) ?? throw ChromeSyncMessage.Invalid("相邻书签缺少排序记录"));
                    return null;
                }
                position = ChromeUniquePosition.Create(Neighbor(siblings[..index].Reverse()), Neighbor(siblings[(index + 1)..]), ClientTag(node.Guid), position);
            }
            if (position is null) throw ChromeSyncMessage.Invalid("缺少节点排序值");
            _ = ChromeUniquePosition.Read(position);
            Bump(metadata);
            metadata.SetNumber(3, 0);
            metadata.SetNumber(8, now);
            metadata.SetText(9, Hash(Specifics(node.Json, node.Parent, position)));
            metadata.SetBytes(11, position);
            metadata.SetFixed32(12, 0);
            if (added)
            {
                if (!tags.Add(ClientTag(node.Guid)) || !serverIds.Add(node.Guid)) throw ChromeSyncMessage.Invalid("新书签与既有同步身份冲突");
                var record = new ChromeSyncMessage();
                record.SetNumber(1, node.Id);
                record.SetBytes(2, metadata.Encode());
                model.AddBytes(2, record.Encode());
                entry = new Entry(model.Fields(2).Last(), record, metadata);
                entries.Add(node.Id, entry);
            }
            else
            {
                entry!.Record.SetBytes(2, metadata.Encode());
                model.ReplaceRaw(entry.Field, entry.Record.Encode());
            }
            positioned.Add(node.Id);
            changed = true;
        }
        if (!changed) return mutation;
        if (entries.Count != afterNodes.Count) throw ChromeSyncMessage.Invalid("修改后的同步节点数不一致");
        after["sync_metadata"] = Convert.ToBase64String(model.Encode());
        return mutation with { Changed = true, Json = BookmarkJson.Serialize(after) };
    }

    private static bool OrderChanged(Node node, Dictionary<long, Node> before, Dictionary<long, Node> after)
    {
        if (!before.TryGetValue(node.Id, out var old) || old.Parent != node.Parent) return true;
        var oldIndex = before.Values.Where(n => n.Parent == node.Parent).Select(n => n.Id).TakeWhile(id => id != node.Id).Count(id => after.ContainsKey(id));
        var newIndex = after.Values.Where(n => n.Parent == node.Parent).Select(n => n.Id).TakeWhile(id => id != node.Id).Count(id => before.ContainsKey(id));
        return oldIndex != newIndex;
    }
    private static bool SameSpecifics(Node a, Node b)
    {
        if (a.Parent != b.Parent) return false;
        foreach (var key in new[] { "guid", "type", "url", "name", "date_added", "date_last_used", "meta_info" })
            if (!JsonNode.DeepEquals(a.Json[key], b.Json[key])) return false;
        return true;
    }
    private static IEnumerable<long> Children(Node node) => (node.Json["children"] as JsonArray ?? []).OfType<JsonObject>()
        .Select(child => long.Parse(BookmarkJson.RequiredString(child, "id"), CultureInfo.InvariantCulture));
    private static Dictionary<long, Node> Nodes(JsonObject document)
    {
        var result = new Dictionary<long, Node>();
        var guids = new HashSet<string>(StringComparer.Ordinal);
        void Walk(JsonObject json, string? parent, int depth)
        {
            var id = long.Parse(BookmarkJson.RequiredString(json, "id"), CultureInfo.InvariantCulture);
            var guid = BookmarkJson.RequiredString(json, "guid");
            if (!Guid.TryParseExact(guid, "D", out _) || guid != guid.ToLowerInvariant() || !guids.Add(guid) || id < 1
                || !result.TryAdd(id, new Node(id, guid, parent, json, depth))) throw ChromeSyncMessage.Invalid("书签身份不唯一或无效");
            if (depth > 512) throw ChromeSyncMessage.Invalid("书签层级过深");
            if (json["children"] is JsonArray children) foreach (var child in children.OfType<JsonObject>()) Walk(child, guid, depth + 1);
        }
        var roots = BookmarkJson.RequiredObject(document, "roots");
        foreach (var root in Roots) Walk(BookmarkJson.RequiredObject(roots, root), null, 0);
        return result;
    }
    private static ChromeSyncMessage NewMetadata(Node node, long now)
    {
        var metadata = new ChromeSyncMessage();
        metadata.SetText(1, ClientTag(node.Guid));
        metadata.SetText(2, node.Guid);
        metadata.SetNumber(3, 0);
        metadata.SetNumber(4, 0);
        metadata.SetNumber(5, 0);
        metadata.SetNumber(6, -1);
        metadata.SetNumber(7, now);
        return metadata;
    }
    private static void Bump(ChromeSyncMessage metadata)
    {
        var sequence = metadata.Number(4);
        if (sequence == metadata.Number(5)) metadata.SetText(10, metadata.Text(9) ?? "");
        metadata.SetNumber(4, checked(sequence + 1));
    }
    internal static string ClientTag(string guid)
    {
        var entity = new ChromeSyncMessage();
        entity.SetBytes(32904, []);
        return Hash([.. entity.Encode(), .. Encoding.UTF8.GetBytes(guid)]);
    }
    private static string Hash(byte[] bytes) => Convert.ToBase64String(SHA1.HashData(bytes));
    internal static byte[] Specifics(JsonObject node, string parentGuid, byte[] position)
    {
        var folder = BookmarkJson.RequiredString(node, "type") == "folder";
        var specifics = new ChromeSyncMessage();
        if (!folder) specifics.SetText(1, CanonicalBookmarkUrl(BookmarkJson.RequiredString(node, "url")));
        var title = BookmarkJson.RequiredString(node, "name");
        var legacy = title.TrimEnd(' ') is "" or "." or ".." ? title + " " : title;
        var legacyBytes = Encoding.UTF8.GetBytes(legacy);
        var length = Math.Min(255, legacyBytes.Length);
        while (length < legacyBytes.Length && (legacyBytes[length] & 0xc0) == 0x80) length--;
        specifics.SetBytes(3, legacyBytes[..length]);
        specifics.SetNumber(4, long.Parse(BookmarkJson.RequiredString(node, "date_added"), CultureInfo.InvariantCulture));
        if (node["meta_info"] is JsonObject meta)
            foreach (var item in meta.OrderBy(p => p.Key, Comparer<string>.Create((a,b)=>Encoding.UTF8.GetBytes(a).AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(b)))))
            {
                var pair = new ChromeSyncMessage(); pair.SetText(1, item.Key); pair.SetText(2, item.Value!.GetValue<string>());
                specifics.AddBytes(6, pair.Encode());
            }
        specifics.SetText(10, BookmarkJson.RequiredString(node, "guid"));
        specifics.SetText(11, title);
        specifics.SetText(14, parentGuid);
        specifics.SetNumber(15, folder ? 2 : 1);
        specifics.SetBytes(16, position);
        if (!folder && long.TryParse(BookmarkJson.OptionalString(node, "date_last_used"), out var lastUsed) && lastUsed != 0) specifics.SetNumber(17, lastUsed);
        var entity = new ChromeSyncMessage(); entity.SetBytes(32904, specifics.Encode()); return entity.Encode();
    }
    internal static string CanonicalBookmarkUrl(string raw)
    {
        var start = 0; var end = raw.Length;
        while (start < end && raw[start] <= 32) start++;
        while (end > start && raw[end - 1] <= 32) end--;
        var value = raw[start..end].Replace("\t", "").Replace("\r", "").Replace("\n", "");
        if (!value.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)) throw ChromeSyncMessage.Invalid("当前同步适配只修改JavaScript书签");
        var output = new StringBuilder("javascript:");
        var component = 0;
        foreach (var item in Encoding.UTF8.GetBytes(value[11..]))
        {
            if (item == '#' && component != 2) { component = 2; output.Append('#'); continue; }
            if (item == '?' && component == 0) { component = 1; output.Append('?'); continue; }
            var escape = item < 32 || item > 126 || (component > 0 && item is (byte)' ' or (byte)'"' or (byte)'<' or (byte)'>') || (component == 2 && item == '`');
            if (escape) output.Append('%').Append(item.ToString("X2", CultureInfo.InvariantCulture)); else output.Append((char)item);
        }
        return output.ToString();
    }
}
