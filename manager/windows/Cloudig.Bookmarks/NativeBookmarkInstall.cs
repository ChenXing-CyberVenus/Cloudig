using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public sealed class BookmarkRelocationRequiresClosedChromeException() : InvalidOperationException("Close Chrome to change the parent of an installed bookmark folder.");

internal static class NativeBookmarkInstall
{
    internal sealed record Result(int Added, string FolderGuid, bool PlacementPending);
    private static string Field(JsonObject n, string key) => BookmarkJson.RequiredString(n, key);
    private static JsonObject[] Children(JsonObject parent) => parent["children"]!.AsArray().OfType<JsonObject>().ToArray();
    private static string Draft() => "Cloudig-" + Guid.NewGuid().ToString("N");

    internal static Result Ensure(BookmarkStore store, BookmarkInstallTarget target, string root, string chrome,
        BookmarkFileEditor inspector, IReadOnlyList<ResolvedBookmark> selected, CancellationToken cancellation)
    {
        using var guard = BookmarkBackupRetention.Lock(root);
        var state = NativeBookmarkOwnership.Load(root, target) ?? new() { Store = store.Path, Installation = target.InstallationId };
        var userData = Directory.GetParent(Path.GetDirectoryName(store.Path)!)!.FullName;
        var cache = Path.Combine(root, "LiveWindow");
        JsonObject Roots() => LiveChromeEditor.Wait(() =>
        {
            try { return LiveBookmarkSnapshot.ReadRoots(store); }
            catch (IOException) { return null; }
            catch (JsonException) { return null; }
        }, "书签同步写入", 12000);
        JsonObject Parent(JsonObject roots) => string.IsNullOrEmpty(target.ParentGuid) ? roots["bookmark_bar"]!.AsObject()
            : NativeBookmarkOwnership.Folders(roots).Single(f => Field(f, "guid") == target.ParentGuid);
        var roots = Roots();
        var parent = Parent(roots);
        var guid = target.ManagedFolderGuid.Length > 0 ? target.ManagedFolderGuid : state.Folder;
        var folder = NativeBookmarkOwnership.Folders(roots).SingleOrDefault(f => Field(f, "guid") == guid);
        if (folder == null && state.Folder.Length > 0 && state.Folder != guid)
            folder = NativeBookmarkOwnership.Folders(roots).SingleOrDefault(f => Field(f, "guid") == state.Folder);
        if (folder != null)
        {
            var markedOwner = (string?)folder["meta_info"]?["cloudig_installation_id"];
            if (markedOwner != target.InstallationId && (markedOwner != null || Field(folder,"guid") != state.Folder))
                throw new IOException("所选书签文件夹不属于本次安装。");
        }
        if (folder != null && !Children(parent).Contains(folder))
        {
            if (target.PlacementPending) throw new BookmarkRelocationRequiresClosedChromeException();
            parent = NativeBookmarkOwnership.Folders(roots).Single(f => Children(f).Contains(folder));
        }
        var parentGuid = Field(parent, "guid");
        var rootName = roots.FirstOrDefault(entry => ReferenceEquals(entry.Value, parent)).Key;
        JsonObject ReadParent()
        {
            var current = Roots();
            return rootName != null ? current[rootName]!.AsObject() : NativeBookmarkOwnership.Folders(current).Single(f => Field(f, "guid") == parentGuid);
        }
        JsonObject ReadFolder() => NativeBookmarkOwnership.Folders(Roots()).Single(f => Field(f, "guid") == state.Folder);
        bool backed = false;
        void Backup()
        {
            if (backed) return;
            var area = Guid.Parse(folder == null ? target.InstallationId : Field(folder, "guid")).ToString("D");
            var dir = Path.Combine(root, "Live", area, DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffffZ", System.Globalization.CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N"));
            LiveUpdate.WriteLog(dir, new JsonObject
            {
                ["format"] = "cloudig/live-bookmarks/1",
                ["folder"] = area,
                ["operation"] = "add",
                ["parent"] = parentGuid,
                ["original_order"] = JsonSerializer.SerializeToNode(Children(parent).Select(n => Field(n, "guid"))),
                ["original_folder_name"] = folder == null ? null : Field(folder, "name"),
                ["original_children"] = JsonSerializer.SerializeToNode(folder == null ? [] : Children(folder).Select(n => Field(n, "guid")).ToArray()),
                ["items"] = new JsonArray()
            });
            BookmarkBackupRetention.Prune(root, dir); backed = true;
        }
        int added = 0;
        cancellation.ThrowIfCancellationRequested();
        var localBar = ReferenceEquals(parent, roots["bookmark_bar"]) && !ChromeProfileDiscovery.Discover(userData)
            .SelectMany(profile => profile.Stores).Any(s => s.ProfileDirectory == store.ProfileDirectory && s.Kind == "account");
        using (var parentEditor = new LazyWindow(() => new(chrome, userData, store.ProfileDirectory, Field(parent, "id"), cache, defaultLocalBar: localBar)))
        {
            if (folder == null)
            {
                Backup();
                if (state.FolderDraft.Length == 0) { state.FolderDraft = Draft(); state.Folder = ""; state.Items.Clear(); state.Save(root, target); }
                JsonObject? FindDraft() => Children(ReadParent()).SingleOrDefault(n => (string?)n["type"] == "folder" && (string?)n["name"] == state.FolderDraft);
                folder = FindDraft();
                if (folder == null) { parentEditor.Get().Create(state.FolderDraft, null); folder = LiveChromeEditor.Wait(FindDraft, "新建文件夹的持久编号", 30000); }
                state.Folder = Field(folder, "guid"); state.Save(root, target); added++;
            }
            if (state.Folder != Field(folder, "guid")) { state.Folder = Field(folder, "guid"); state.Items.Clear(); state.Save(root, target); }
            var siblings = Children(ReadParent()); var index = Array.FindIndex(siblings, n => Field(n, "guid") == state.Folder);
            if (index < 0) throw new IOException("Chrome 文件夹的位置已经改变。");
            var name = Field(siblings[index], "name");
            if (((state.FolderDraft.Length > 0 && name == state.FolderDraft) || target.PlacementPending) && name != target.FolderName)
            {
                Backup(); parentEditor.Get().RenameFolder(index, name, target.FolderName);
                LiveChromeEditor.Wait(() => Field(ReadFolder(), "name") == target.FolderName ? "saved" : null, "文件夹名称保存", 30000);
            }
            if (state.FolderDraft.Length > 0) { state.FolderDraft = ""; state.Save(root, target); }
        }
        using var editor = new LazyWindow(() => new(chrome, userData, store.ProfileDirectory, Field(folder, "id"), cache));
        var known = inspector.SelectLiveFolder(Roots()).Items.Select(n => n.Slot).ToHashSet();
        foreach (var resolved in selected)
        {
            cancellation.ThrowIfCancellationRequested();
            var def = resolved.Definition; var slot = def.VariantId;
            state.Items.TryGetValue(slot, out var item);
            if (known.Contains(slot) && (item == null || item.Draft.Length == 0)) continue;
            Backup();
            if (item == null || item.Draft.Length == 0)
            {
                item = new("", Draft(), BookmarkDisplayName.Format(def.Label, resolved.EffectiveProfile, def.Version), def.Version, def.Sha256, resolved.EffectiveProfile);
                state.Items[slot] = item; state.Save(root, target);
            }
            JsonObject? Find() => Children(ReadFolder()).SingleOrDefault(n => (string?)n["type"] == "url"
                && (item.Guid.Length > 0 ? Field(n, "guid") == item.Guid : Field(n, "name") == item.Draft));
            var node = Find();
            if (node == null)
            {
                editor.Get().Create(item.Draft, def.Url);
                node = LiveChromeEditor.Wait(Find, "新书签原位保存", 30000);
            }
            if (!LiveUpdate.Equivalent(Field(node, "url"), def.Url)) throw new IOException("新书签网址与安装包不符：" + slot);
            item = item with { Guid = Field(node, "guid") }; state.Items[slot] = item; state.Save(root, target);
            if (Field(node, "name") == item.Draft)
            {
                var index = Array.FindIndex(Children(ReadFolder()), n => Field(n, "guid") == item.Guid);
                editor.Get().Edit(new(Field(node, "id"), item.Guid, index, slot, item.Draft, Field(node, "url"), null), item.Title, def.Url);
                LiveChromeEditor.Wait(() => Find() is { } n && Field(n, "name") == item.Title ? n : null, "最终书签名称", 30000);
            }
            state.Items[slot] = item with { Draft = "" }; state.Save(root, target); added++;
        }
        editor.Dispose();
        if (target.PlaceFirst)
        {
            var siblings = Children(ReadParent());
            var index = Array.FindIndex(siblings, n => Field(n, "guid") == state.Folder);
            if (index < 0) throw new IOException("Chrome 保存前，选定的文件夹已改变。");
            if (index > 0)
            {
                Backup();
                var name = Field(siblings[index], "name");
                using (var placement = new LiveChromeEditor(chrome, userData, store.ProfileDirectory, Field(parent, "id"), cache, defaultLocalBar: localBar))
                {
                    var current = Children(ReadParent());
                    if (current.Length <= index || Field(current[index], "guid") != state.Folder || Field(current[0], "guid") != Field(siblings[0], "guid")) return new(added, state.Folder, true);
                    try
                    {
                        if (!placement.MoveFirst(index, name, Field(siblings[0], "name"), NativeBookmarkOwnership.Folders(Roots()).Count(f => Field(f, "name") == name) == 1)) return new(added, state.Folder, true);
                        LiveChromeEditor.Wait(() => Field(Children(ReadParent())[0], "guid") == state.Folder ? "first" : null, "文件夹置顶保存", 20000);
                    }
                    catch (Exception error) when (error is IOException or System.Runtime.InteropServices.COMException) { return new(added, state.Folder, true); }
                }
            }
        }
        return new(added, state.Folder, false);
    }
    private sealed class LazyWindow(Func<LiveChromeEditor> open) : IDisposable
    {
        private LiveChromeEditor? window;
        internal LiveChromeEditor Get() => window ??= open();
        public void Dispose() { window?.Dispose(); window = null; }
    }
}
