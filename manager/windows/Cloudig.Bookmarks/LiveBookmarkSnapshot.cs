using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

// Read-only. The browser owns every write, including sync and encrypted mirrors.
public sealed record LiveBookmark(string Id,string Guid,int Index,string Slot,string Title,string Url,string? DefaultTitle,string? Version=null);
public sealed record LiveBookmarkSnapshot(string FolderId,string FolderGuid,IReadOnlyList<LiveBookmark> Items)
{
    public static LiveBookmarkSnapshot Read(BookmarkStore store)
        => Read(store, ReadTestFolder);
    internal static LiveBookmarkSnapshot Read(BookmarkStore store, Func<JsonObject, LiveBookmarkSnapshot> select)
        => select(ReadRoots(store));

    internal static JsonObject ReadRoots(BookmarkStore store)
    {
        if(store.Kind!="local")throw new IOException("热更新只支持已选择的本地测试书签库。");
        if(store.AwaitingFirstBookmark && !File.Exists(store.Path))
            return BookmarkJson.ParseObject(ChromeProfileDiscovery.ReadBookmarkJson(store))["roots"]!.AsObject();
        JsonObject ReadOne(string path) {
            var bytes=ChromeProfileDiscovery.ReadAllBytesShared(path);
            if(ChromeBookmarkEncryption.IsEncryptedStore(path)){
                using var cipher=ChromeBookmarkEncryption.Open(path);bytes=cipher.Decrypt(bytes);
            }
            var data=BookmarkJson.ParseObject(ChromeProfileDiscovery.DecodeUtf8(bytes));
            ChromeBookmarkChecksums.AssertValid(data);return data;
        }
        var doc=ReadOne(store.Path);
        var companion=ChromeBookmarkEncryption.CompanionPath(store.Path);
        if(companion!=null && File.Exists(companion) && !JsonNode.DeepEquals(doc,ReadOne(companion)))
            throw new IOException("Chrome 正在保存书签，两份库尚未一致。");
        return doc["roots"]!.AsObject();
    }
    private static LiveBookmarkSnapshot ReadTestFolder(JsonObject roots)
    {
        static IEnumerable<JsonObject> Walk(JsonObject o) {
            yield return o;
            if(o["children"] is JsonArray a)foreach(var child in a)foreach(var n in Walk(child!.AsObject()))yield return n;
        }
        var tagged=roots.SelectMany(p=>Walk(p.Value!.AsObject())).Where(n=>(string?)n["meta_info"]?["cloudig_test_folder"]=="1").ToArray();
        var bar=roots["bookmark_bar"]!["children"]!.AsArray();
        if(tagged.Length!=1 || !bar.Contains(tagged[0]) || (string?)tagged[0]["name"]!="书签测试" ||
            bar.Count(n=>(string?)n?["type"]=="folder"&&(string?)n?["name"]=="书签测试")!=1)
            throw new InvalidDataException("没有找到唯一的原有托管「书签测试」文件夹。在线更新不会新建或接管同名文件夹。");
        var folder=tagged[0];var children=folder["children"]!.AsArray();
        var items=new List<LiveBookmark>();
        for(var i=0;i<children.Count;i++){
            var n=children[i]!.AsObject();var m=n["meta_info"];if((string?)m?["cloudig_test_managed"]!="1")continue;
            string Field(string key)=>BookmarkJson.RequiredString(n,key);
            if(Field("type")!="url")throw new InvalidDataException("测试槽位不是网址。");
            items.Add(new(Field("id"),Field("guid"),i,BookmarkJson.RequiredString(m!.AsObject(),"cloudig_test_id"),
                Field("name"),Field("url"),(string?)m["cloudig_test_default_title"]));
        }
        if(items.Select(n=>n.Slot).Distinct().Count()!=items.Count || items.Select(n=>n.Guid).Distinct().Count()!=items.Count)
            throw new InvalidDataException("测试书签身份重复，未写入。");
        var folderId=BookmarkJson.RequiredString(folder,"id");
        if(!long.TryParse(folderId,out var id)||id<=0)throw new InvalidDataException("书签文件夹编号无效。");
        return new(folderId,BookmarkJson.RequiredString(folder,"guid"),items);
    }
}
