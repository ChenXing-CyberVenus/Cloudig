using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

internal static class LiveUpdate
{
    internal static byte[] ScriptBytes(string url){
        if(!url.StartsWith("javascript:",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("托管节点不再是 javascript: 书签，未接管自定义网址。");
        var bytes=Encoding.UTF8.GetBytes(url[11..]);int w=0;
        static int Hex(byte b)=>b is >=48 and <=57?b-48:b is >=65 and <=70?b-55:b is >=97 and <=102?b-87:-1;
        for(int i=0;i<bytes.Length;i++){
            if(bytes[i]==37&&i+2<bytes.Length&&Hex(bytes[i+1]) is var a and >=0&&Hex(bytes[i+2]) is var b and >=0){bytes[w++]=(byte)(a*16+b);i+=2;}
            else bytes[w++]=bytes[i];
        }
        return bytes.AsSpan(0,w).ToArray();
    }
    internal static bool Equivalent(string a,string b)=>a==b||ScriptBytes(a).AsSpan().SequenceEqual(ScriptBytes(b));
    internal const int NativeInputLimit=500*1024;
    internal static string EditorSpelling(string stored){
        if(stored.Length<=NativeInputLimit)return stored;
        // Chrome's serialized GURL can exceed the editor limit even though
        // the original bookmark fit. Only shorten display-safe escapes; keep
        // %, URL delimiters, controls and terminal spaces encoded. The backup
        // retains the exact stored spelling, not this reversible input copy.
        var s=System.Text.RegularExpressions.Regex.Replace(stored,@"(?:%[89A-Fa-f][0-9A-Fa-f])+|%(?:20|22|3[cCeE]|60)",m=>
            m.Value=="%20"&&m.Index+m.Length==stored.Length?m.Value:Uri.UnescapeDataString(m.Value));
        if(s.Length>NativeInputLimit||!Equivalent(stored,s))
            throw new InvalidDataException("无法在 Chrome 原生输入上限内无损写回该旧值；未截断或改写书签。");
        return s;
    }
    internal static string Hash(string url)=>Convert.ToHexString(SHA256.HashData(ScriptBytes(url)));
    private sealed record Change(LiveBookmark From,string Title,string Url,bool Auto,string? Version=null);
    private static string Area(string backupRoot,string guid)=>Path.Combine(backupRoot,"Live",Guid.Parse(guid).ToString("D"));
    internal const string Journal="before.json.gz";
    internal static IEnumerable<string> Groups(string dir)=>Directory.Exists(dir)?Directory.GetDirectories(dir)
        .Where(p=>System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(p),@"^[0-9]{8}T[0-9]{13}Z-[a-f0-9]{32}$") && (File.GetAttributes(p)&FileAttributes.ReparsePoint)==0 && File.Exists(Path.Combine(p,Journal)))
        .OrderDescending(StringComparer.Ordinal):[];
    internal static JsonObject ReadLog(string p){
        using var f=File.OpenRead(Path.Combine(p,Journal));using var gz=new GZipStream(f,CompressionMode.Decompress);
        var j=JsonNode.Parse(gz)!.AsObject();if((string?)j["format"] is not ("cloudig/live-test-bookmarks/1" or "cloudig/live-bookmarks/1"))throw new InvalidDataException("不支持的热更新备份。");return j;
    }
    internal static Dictionary<string,JsonObject> Receipts(string? root,string folder) {
        if (root is null || !Guid.TryParse(folder,out _)) return [];
        var area=Area(root,folder);
        var metadata=Path.Combine(area,"versions.json");
        if (File.Exists(metadata)) {
            var saved=JsonNode.Parse(File.ReadAllBytes(metadata))!.AsObject();
            if ((string?)saved["folder"]!=folder || (string?)saved["format"]!="cloudig/live-bookmark-versions/1") throw new InvalidDataException("Invalid bookmark version receipt.");
            return saved["items"]!.AsArray().OfType<JsonObject>().ToDictionary(r=>(string)r["guid"]!);
        }
        var last=Groups(area).FirstOrDefault();
        if (last is null) return [];
        var log=ReadLog(last);
        if ((string?)log["folder"]!=folder) return [];
        return log["items"]!.AsArray().OfType<JsonObject>().ToDictionary(r=>(string)r["guid"]!);
    }
    internal static void WriteLog(string dir,JsonObject j){
        Directory.CreateDirectory(dir);var file=Path.Combine(dir,Journal);
        using(var f=new FileStream(file+".pending",FileMode.CreateNew,FileAccess.Write,FileShare.None))
        {using(var gz=new GZipStream(f,CompressionLevel.Fastest,true))using(var w=new Utf8JsonWriter(gz)){j.WriteTo(w);}f.Flush(true);}
        File.Move(file+".pending",file); // No browser mutation until backup is readable.
        if(!JsonNode.DeepEquals(j,ReadLog(dir)))throw new IOException("热更新备份回读不一致。");
    }
    internal static Dictionary<string,string> LastDefaults(string root,LiveBookmarkSnapshot snapshot){
        var last=Groups(Area(root,snapshot.FolderGuid)).FirstOrDefault();var map=new Dictionary<string,string>();
        if(last==null)return map;var j=ReadLog(last);if((string?)j["folder"]!=snapshot.FolderGuid)return map;
        var current=snapshot.Items.ToDictionary(n=>n.Guid);
        foreach(var r in j["items"]!.AsArray()){
            if((bool?)r!["auto"]!=true||!current.TryGetValue((string)r["guid"]!,out var n))continue;
            if((n.Title==(string?)r["new_title"] && Hash(n.Url)==(string?)r["new_hash"])||
               (n.Title==(string?)r["old_title"] && Equivalent(n.Url,(string)r["old_url"]!)))map[n.Guid]=n.Title;
        }
        return map;
    }
    private static LiveBookmarkSnapshot Stable(Func<LiveBookmarkSnapshot> read,Func<LiveBookmarkSnapshot,bool>? accept=null,int ms=16000){
        var clock=Stopwatch.StartNew();Exception? reason=null;
        do{
            try{var s=read();if(accept?.Invoke(s)!=false)return s;reason=null;}
            catch(Exception e)when(e is IOException or InvalidDataException or JsonException or CryptographicException){reason=e;}
            Thread.Sleep(300);
        }while(clock.ElapsedMilliseconds<ms);
        throw new IOException("Chrome 尚未持久保存预期的完整网址、名称或原位身份。",reason);
    }
    private static bool SameNode(LiveBookmark a,LiveBookmark b)=>a.Guid==b.Guid&&a.Id==b.Id&&a.Index==b.Index&&a.Slot==b.Slot;
    private static bool Verified(LiveBookmarkSnapshot s,string folder,List<Change> plan)=>
        s.FolderGuid==folder && s.Items.Count==plan.Count && s.Items.Zip(plan).All(pair=>
        SameNode(pair.First,pair.Second.From)&&pair.First.Title==pair.Second.Title&&Equivalent(pair.First.Url,pair.Second.Url));
    internal static (int Count,string? Backup) Execute(BookmarkPackage pkg,BookmarkStore store,string root,string chrome,bool undo=false,Action<int>? afterEdit=null){
        var targets=pkg.Bookmarks.ToDictionary(b=>b.Id,b=>(b.TitleZh,b.Url,b.Version));
        return Execute(store, root, chrome, () => LiveBookmarkSnapshot.Read(store), targets, true, undo, afterEdit);
    }

    internal static (int Count,string? Backup) Execute(BookmarkStore store, string root, string chrome,
        Func<LiveBookmarkSnapshot> read, IReadOnlyDictionary<string,(string Title,string Url,string Version)> targets,
        bool requireFullSet, bool undo=false, Action<int>? afterEdit=null) {
        if(store.Kind!="local")throw new InvalidDataException("在线更新不操作账号书签库。");
        var userData=Directory.GetParent(Path.GetDirectoryName(store.Path)!)!.FullName;
        using var guard=requireFullSet?null:BookmarkBackupRetention.Lock(root);
        var snapshot=Stable(read);
        var folder=snapshot.FolderGuid;var area=Area(root,folder);var defaults=LastDefaults(root,snapshot);
        var plan=new List<Change>();

        if(undo){
            var last=Groups(area).FirstOrDefault()??throw new IOException("该文件夹尚无在线更新备份。");
            var log=ReadLog(last);if((string?)log["folder"]!=folder)throw new InvalidDataException("备份不属于当前文件夹。");
            var rows=log["items"]!.AsArray().ToDictionary(n=>(string)n!["guid"]!);
            foreach(var n in snapshot.Items){
                if(!rows.TryGetValue(n.Guid,out var r)||(string?)r!["slot"]!=n.Slot ||(int?)r["index"]!=n.Index ||(string?)r["id"]!=n.Id)throw new IOException("书签身份／位置与备份不同，未还原。");
                var old=(string)r["old_url"]!;var title=(string)r["old_title"]!;
                if(!(n.Title==title&&Equivalent(n.Url,old))&&!(n.Title==(string?)r["new_title"]&&Hash(n.Url)==(string?)r["new_hash"]))throw new IOException("备份后的书签已有其他编辑，不会覆盖："+n.Title);
                plan.Add(new(n,title,old,(bool?)r["auto"]==true));
            }
            if(rows.Count!=plan.Count)throw new IOException("测试文件夹成员与备份不一致。");
        }else{
            if((requireFullSet && snapshot.Items.Count!=targets.Count) || targets.Keys.Except(snapshot.Items.Select(n=>n.Slot)).Any())
                throw new InvalidDataException("在线模式只原位更新已有的书签；本次需要新增条目，请退出 Chrome 后安装。");
            foreach(var n in snapshot.Items){
                if (!targets.TryGetValue(n.Slot, out var d)) {
                    plan.Add(new(n,n.Title,n.Url,n.Title==n.DefaultTitle || defaults.ContainsKey(n.Guid),n.Version));
                    continue;
                }
                var auto=n.Title==n.DefaultTitle||defaults.ContainsKey(n.Guid)||n.Title==d.Title;
                if (n.Version!=null && BookmarkChangelog.IsNewerVersion(n.Version,d.Version)) {
                    plan.Add(new(n,n.Title,n.Url,auto,n.Version));
                    continue;
                }
                plan.Add(new(n,auto?d.Title:n.Title,d.Url,auto,d.Version));
            }
        }
        var edits=plan.Where(c=>c.Title!=c.From.Title||!Equivalent(c.From.Url,c.Url)).ToList();
        if(edits.Count==0)return(0,null);
        // Prove both directions fit before the first mutation.
        foreach(var c in edits){EditorSpelling(c.From.Url);EditorSpelling(c.Url);
            if(Math.Max(c.Title.Length,c.From.Title.Length)>NativeInputLimit)throw new InvalidDataException("书签名称超出可无损还原的上限。");}
        var path=Path.Combine(area,DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffffZ",System.Globalization.CultureInfo.InvariantCulture)+"-"+Guid.NewGuid().ToString("N"));
        var entries=new JsonArray();foreach(var c in plan)entries.Add((JsonNode)new JsonObject{
            ["guid"]=c.From.Guid,["id"]=c.From.Id,["slot"]=c.From.Slot,["index"]=c.From.Index,["old_title"]=c.From.Title,
            ["old_url"]=c.From.Url,["new_title"]=c.Title,["new_hash"]=Hash(c.Url),["version"]=c.Version,["old_version"]=c.From.Version,["auto"]=c.Auto});
        WriteLog(path,new JsonObject{["format"]=requireFullSet?"cloudig/live-test-bookmarks/1":"cloudig/live-bookmarks/1",["folder"]=folder,["items"]=entries});
        if (!requireFullSet)
        {
            // Browser-owned writes cannot change Cloudig metadata. Keep only
            // identity and byte fingerprints outside the two rollback groups.
            // Both sides are recorded so an interruption is reconciled by bytes.
            var versions=new JsonArray();
            foreach (var row in entries.OfType<JsonObject>()) {
                var version=(JsonObject)row.DeepClone();
                version["old_hash"]=Hash((string)version["old_url"]!);
                version.Remove("old_url");
                versions.Add(version);
            }
            var meta=Path.Combine(area,"versions.json");
            var pending=meta+".pending";
            File.WriteAllText(pending,new JsonObject{["format"]="cloudig/live-bookmark-versions/1",["folder"]=folder,["items"]=versions}.ToJsonString());
            File.Move(pending,meta,true);
            BookmarkBackupRetention.Prune(root,path);
        }
        var cache=Path.Combine(root,"LiveWindow");var attempted=new List<Change>();int? originalBrowser=null;
        try{
            using var editor=new LiveChromeEditor(chrome,userData,store.ProfileDirectory,snapshot.FolderId,cache);
            originalBrowser=editor.BrowserPid;
            var stamp=DateTime.MinValue;var disk=snapshot;
            foreach(var c in edits){
                var observed=File.GetLastWriteTimeUtc(store.Path);
                if(observed!=stamp){disk=Stable(read);stamp=observed;}
                var candidate=disk.Items.SingleOrDefault(n=>n.Guid==c.From.Guid);
                if(disk.FolderGuid!=folder||candidate==null||!SameNode(candidate,c.From)||candidate.Title!=c.From.Title||!Equivalent(candidate.Url,c.From.Url))
                    throw new IOException("操作期间书签发生外部修改，未覆盖："+c.From.Title);
                attempted.Add(c);editor.Edit(c.From,c.Title,c.Url);afterEdit?.Invoke(attempted.Count);
            }
            Stable(read,s=>Verified(s,folder,plan),30000);
        }catch(Exception problem){
            try{
                if(attempted.Count>0){
                    // Chrome flushes its in-memory model asynchronously. Never restore a
                    // whole profile file while Chrome is live, or overwrite a third value.
                    Thread.Sleep(3500);
                    var now=Stable(read);if(now.FolderGuid!=folder)throw new IOException("目标文件夹身份已变。");
                    using var restore=new LazyEditor(()=>new LiveChromeEditor(chrome,userData,store.ProfileDirectory,snapshot.FolderId,cache,originalBrowser));
                    foreach(var c in attempted.AsEnumerable().Reverse()){
                        var n=now.Items.Single(x=>x.Guid==c.From.Guid);
                        if(!SameNode(n,c.From))throw new IOException("位置已变化。");
                        if(n.Title==c.From.Title&&Equivalent(n.Url,c.From.Url))continue;
                        if(n.Title!=c.Title||!Equivalent(n.Url,c.Url))throw new IOException("检测到第三种值，保留现场。");
                        restore.Get().Edit(n,c.From.Title,c.From.Url);
                    }
                    Stable(read,s=>s.FolderGuid==folder && attempted.All(c=>s.Items.Any(n=>SameNode(n,c.From)&&n.Title==c.From.Title&&Equivalent(n.Url,c.From.Url))),20000);
                }
            }catch(Exception recovery){throw new IOException($"在线更新未通过，不能证明回滚完成。原值备份：{path}",new AggregateException(problem,recovery));}
            throw new IOException($"在线更新未通过，本次涉及的书签已核对为原值。备份：{path}",problem);
        }
        // Only retire old journals created by this exact code, inside this GUID's own area.
        foreach(var old in requireFullSet ? Groups(area).Skip(BookmarkBackupRetention.MaximumGroups) : Enumerable.Empty<string>()){
            try{var f=Path.Combine(old,Journal);if(Directory.GetFileSystemEntries(old).Length==1 && (File.GetAttributes(f)&FileAttributes.ReparsePoint)==0 && (string?)ReadLog(old)["folder"]==folder){File.Delete(f);Directory.Delete(old);}}catch(IOException){}
        }
        return(edits.Count,path);
    }
    private sealed class LazyEditor(Func<LiveChromeEditor> create):IDisposable{
        private LiveChromeEditor? editor;public LiveChromeEditor Get()=>editor??=create();public void Dispose()=>editor?.Dispose();
    }
}
