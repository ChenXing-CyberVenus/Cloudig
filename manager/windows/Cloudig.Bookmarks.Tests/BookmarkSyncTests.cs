using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

internal static class BookmarkSyncTests
{
    private static readonly DateTime Now = new(2026, 9, 8, 12, 0, 0, DateTimeKind.Utc);
    private static int _checks;
    private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); _checks++; }
    internal static int Run()
    {
        Check(BookmarkDisplayName.Format("ChatGPT",BookmarkProfiles.Light,"3.7.23-light")=="ChatGPT（轻装）· 3.7.23-Light · Cloudig","Light display name or spacing is not exact");
        Check(BookmarkDisplayName.Format("ChatGPT",BookmarkProfiles.Full,"1.0.19-full")=="ChatGPT（全量）· 1.0.19-Full · Cloudig","Full display name or spacing is not exact");
        Check(BookmarkDisplayName.Format("ChatGPT",BookmarkProfiles.AllBranches,"1.0.19-all-branches")=="ChatGPT（整树）· 1.0.19-Tree · Cloudig","Tree display name or spacing is not exact");
        Check(BookmarkDisplayName.Format("豆包",BookmarkProfiles.Full,"1.0.19.2")=="豆包（全量）· 1.0.19.2-Full · Cloudig","Numeric display version was truncated");
        var wire = new ChromeSyncMessage(); wire.SetNumber(1, -1); wire.SetBytes(88, [0, 1, 2, 255]); wire.SetFixed32(99, uint.MaxValue);
        Check(ChromeSyncMessage.Parse(wire.Encode()).Encode().SequenceEqual(wire.Encode()), "Wire roundtrip loses unknown fields");
        foreach (var bytes in new byte[][] { [128], [10, 8, 1], [0], [8,255,255,255,255,255,255,255,255,255,2] })
            Fails(()=>ChromeSyncMessage.Parse(bytes), "Malformed wire was accepted");
        Check(ChromeUniquePosition.Compress([0,0,0,0,1]).SequenceEqual(new byte[]{0,0,0,0,255,255,255,251,1}),"Current Chromium RLE high-run encoding drifted");
        Check(ChromeUniquePosition.Compress([9,9,9,9,1]).SequenceEqual(new byte[]{9,9,9,9,0,0,0,4,1}),"Current Chromium RLE low-run encoding drifted");
        var random = new Random(17);
        byte[]? left = null;
        for (var index = 0; index < 80; index++)
        {
            var tag = ChromeBookmarkSync.ClientTag(Guid.NewGuid().ToString("D"));
            var value = ChromeUniquePosition.Create(left, null, tag);
            var plain = ChromeUniquePosition.Read(value);
            Check(left is null || ChromeUniquePosition.Compare(left, plain) < 0, "Append position is not increasing");
            var beforePosition = ChromeUniquePosition.Read(ChromeUniquePosition.Create(null, plain, tag));
            Check(ChromeUniquePosition.Compare(beforePosition, plain) < 0, "Prepend position is not before its neighbor");
            var middle = ChromeUniquePosition.Read(ChromeUniquePosition.Create(beforePosition, plain, tag));
            Check(ChromeUniquePosition.Compare(beforePosition, middle)<0 && ChromeUniquePosition.Compare(middle, plain)<0, "Between position escaped its interval");
            var raw = new byte[random.Next(28, 400)]; random.NextBytes(raw); raw[^1] = 127;
            var proto = new ChromeSyncMessage(); proto.SetBytes(4, ChromeUniquePosition.Compress(raw));
            Check(ChromeUniquePosition.Read(proto.Encode()).SequenceEqual(raw), "UniquePosition roundtrip changed bytes");
            left = plain;
        }
        var seed = Seed();
        var original = seed.ToJsonString();
        var originalRecords = Records(seed);
        var target = BookmarkInstallTarget.Default() with { InstallationId="isolated-sync-test" };
        var install = new BookmarkFileEditor(Package("1.0.0"), target:target);
        var firstMutation = install.Mutate(original, BookmarkOperation.InstallOrRepair, Now);
        var first = ChromeBookmarkSync.Apply(original, firstMutation, Now);
        var firstDoc = JsonNode.Parse(first.Json)!.AsObject();
        var folder = Find(firstDoc, first.ManagedFolderGuid);
        Check(first.Changed && first.Added == 2, "Initial install count changed");
        Check(Bar(firstDoc)[0]!["guid"]!.GetValue<string>() == first.ManagedFolderGuid, "Folder was not inserted first");
        var firstRecords = Records(firstDoc);
        Check(firstRecords.Count == originalRecords.Count + 2, "New nodes are untracked");
        foreach (var (id, raw) in originalRecords) Check(raw.SequenceEqual(firstRecords[id]), "An unrelated sync record changed");
        Check(State(seed).SequenceEqual(State(firstDoc)), "Global sync state changed");
        Check(Meta(firstDoc, Id(folder)).Number(4)==1 && Meta(firstDoc, Id(folder)).Number(6)==-1, "New folder is not queued as a local creation");
        AssertOrder(firstDoc);
        var unchanged = ChromeBookmarkSync.Apply(first.Json, install.Mutate(first.Json, BookmarkOperation.InstallOrRepair, Now), Now);
        Check(!unchanged.Changed && unchanged.Json==first.Json, "Repeated installation inflated sync metadata");

        var oldNamed=JsonNode.Parse(first.Json)!.AsObject();
        var oldBookmark=Find(oldNamed,first.ManagedFolderGuid)["children"]!.AsArray()[0]!.AsObject();
        oldBookmark["name"]="保存ChatGPT-轻量Light-1.0.0-Cloudig";oldBookmark["meta_info"]!["cloudig_default_title"]="保存ChatGPT-轻量Light-1.0.0-Cloudig";
        Checksums(oldNamed);var oldJson=oldNamed.ToJsonString();
        Check(install.Inspect(oldJson).Status=="current","An automatic naming change became a false version update warning");
        var renamed=ChromeBookmarkSync.Apply(oldJson,install.Mutate(oldJson,BookmarkOperation.InstallOrRepair,Now),Now);
        var renamedBookmark=Find(JsonNode.Parse(renamed.Json)!.AsObject(),first.ManagedFolderGuid)["children"]!.AsArray()[0]!.AsObject();
        Check(renamedBookmark["name"]!.GetValue<string>()=="ChatGPT（轻装）· 1.0.0-Light · Cloudig","Old automatic name was not updated");
        Check(renamedBookmark["id"]!.GetValue<string>()==oldBookmark["id"]!.GetValue<string>()&&renamedBookmark["url"]!.GetValue<string>()==oldBookmark["url"]!.GetValue<string>(),"Rename changed the bookmark identity or script");
        oldBookmark["name"]="老婆自己的名字";oldBookmark["meta_info"]!.AsObject().Remove("cloudig_default_title");Checksums(oldNamed);oldJson=oldNamed.ToJsonString();
        var custom=install.Mutate(oldJson,BookmarkOperation.InstallOrRepair,Now);
        Check(Find(JsonNode.Parse(custom.Json)!.AsObject(),first.ManagedFolderGuid)["children"]!.AsArray()[0]!["name"]!.GetValue<string>()=="老婆自己的名字","Custom title without old default metadata was overwritten");
        var newer=JsonNode.Parse(first.Json)!.AsObject();var newerBookmark=Find(newer,first.ManagedFolderGuid)["children"]!.AsArray()[0]!.AsObject();
        newerBookmark["meta_info"]!["cloudig_version"]="9.0.0-light";newerBookmark["url"]="javascript:void('newer')";Checksums(newer);
        var newerJson=newer.ToJsonString();var newerResult=ChromeBookmarkSync.Apply(newerJson,install.Mutate(newerJson,BookmarkOperation.InstallOrRepair,Now),Now);
        var keptNewer=Find(JsonNode.Parse(newerResult.Json)!.AsObject(),first.ManagedFolderGuid)["children"]!.AsArray()[0]!.AsObject();
        Check(keptNewer["name"]!.GetValue<string>()=="ChatGPT（轻装）· 9.0.0-Light · Cloudig"&&keptNewer["url"]!.GetValue<string>()=="javascript:void('newer')"&&keptNewer["meta_info"]!["cloudig_version"]!.GetValue<string>()=="9.0.0-light","Rename downgraded or mislabeled a newer installed version");
        Check(!ChromeBookmarkSync.Apply(newerResult.Json,install.Mutate(newerResult.Json,BookmarkOperation.InstallOrRepair,Now),Now).Changed,"Newer-version rename is not idempotent");

        var full = new BookmarkFileEditor(Package("1.0.0"), requestedProfile:BookmarkProfiles.Full, target:target);
        var incremental = ChromeBookmarkSync.Apply(first.Json, full.Mutate(first.Json, BookmarkOperation.InstallOrRepair, Now), Now);
        var incrementalDoc = JsonNode.Parse(incremental.Json)!.AsObject();
        Check(Find(incrementalDoc, first.ManagedFolderGuid)["children"]!.AsArray().Count==2, "Incremental profile replaced another profile");
        AssertOrder(incrementalDoc);
        var updatedEditor = new BookmarkFileEditor(Package("1.1.0"), target:target);
        var updated = ChromeBookmarkSync.Apply(incremental.Json, updatedEditor.Mutate(incremental.Json, BookmarkOperation.InstallOrRepair, Now), Now);
        var updatedDoc = JsonNode.Parse(updated.Json)!.AsObject();
        Check(Records(updatedDoc).Count == Records(incrementalDoc).Count, "Update created duplicate tracking entities");
        var light = Find(updatedDoc, first.ManagedFolderGuid)["children"]!.AsArray()[0]!.AsObject();
        Check(Meta(updatedDoc, Id(light)).Number(4)==2, "Updated URL did not increment the local sequence");

        // The selected folder is the only order change. Its siblings must keep
        // their byte-identical metadata, even though their local indexes shift.
        var movedDoc = JsonNode.Parse(updated.Json)!.AsObject();
        var movedFolder = Bar(movedDoc)[0]!.AsObject(); Bar(movedDoc).RemoveAt(0); Bar(movedDoc).Add(movedFolder);
        var m = Model(movedDoc); var rec = m.Fields(2).Select(f=>(f,r:ChromeSyncMessage.Parse(f.Data))).Single(x=>x.r.Number(1)==Id(movedFolder));
        var md = ChromeSyncMessage.Parse(rec.r.Bytes(2)!);
        var other = Meta(movedDoc, Id(Bar(movedDoc)[^2]!.AsObject())).Bytes(11)!;
        var lastPosition = ChromeUniquePosition.Create(ChromeUniquePosition.Read(other), null, ChromeBookmarkSync.ClientTag(first.ManagedFolderGuid));
        md.SetBytes(11,lastPosition); md.SetText(9,Hash(ChromeBookmarkSync.Specifics(movedFolder, BarRoot(movedDoc)["guid"]!.GetValue<string>(),lastPosition)));
        rec.r.SetBytes(2,md.Encode()); m.ReplaceRaw(rec.f,rec.r.Encode()); movedDoc["sync_metadata"]=Convert.ToBase64String(m.Encode()); Checksums(movedDoc);
        var movedJson=movedDoc.ToJsonString();
        var restored=ChromeBookmarkSync.Apply(movedJson,updatedEditor.Mutate(movedJson,BookmarkOperation.InstallOrRepair,Now),Now);
        var restoredDoc=JsonNode.Parse(restored.Json)!.AsObject(); AssertOrder(restoredDoc);
        Check(Bar(restoredDoc)[0]!["guid"]!.GetValue<string>()==first.ManagedFolderGuid,"Repair failed to restore first position");
        foreach(var (id,raw) in originalRecords) Check(raw.SequenceEqual(Records(restoredDoc)[id]),"Moving the folder rewrote another bookmark's tracking record");
        var leaveOrder=new BookmarkFileEditor(Package("1.1.0"),target:target with {PlaceFirst=false});
        Check(!ChromeBookmarkSync.Apply(movedJson,leaveOrder.Mutate(movedJson,BookmarkOperation.InstallOrRepair,Now),Now).Changed,"PlaceFirst=false reordered the folder");

        var removed=ChromeBookmarkSync.Apply(restored.Json,updatedEditor.Mutate(restored.Json,BookmarkOperation.Remove,Now),Now);
        var removedDoc=JsonNode.Parse(removed.Json)!.AsObject();
        Check(Model(removedDoc).Fields(2).Select(f=>ChromeSyncMessage.Parse(f.Data)).Count(r=>!r.Has(1))==1,"Removal did not produce a tombstone");
        Check(Find(removedDoc,first.ManagedFolderGuid)["children"]!.AsArray().Count==1,"Removing Light also removed Full");
        var removeFull=ChromeBookmarkSync.Apply(removed.Json,full.Mutate(removed.Json,BookmarkOperation.Remove,Now),Now);
        var finalDoc=JsonNode.Parse(removeFull.Json)!.AsObject();
        Check(Model(finalDoc).Fields(2).Select(f=>ChromeSyncMessage.Parse(f.Data)).Count(r=>!r.Has(1))==3,"Folder/children deletion tracking is incomplete");
        Check(Records(finalDoc).Count==originalRecords.Count,"Uninstall damaged unrelated live tracking");

        var missing = JsonNode.Parse(first.Json)!.AsObject(); var missingModel=Model(missing);
        missingModel.RemoveRaw(missingModel.Fields(2).Single(f=>ChromeSyncMessage.Parse(f.Data).Number(1)==Id(folder)));
        missing["sync_metadata"]=Convert.ToBase64String(missingModel.Encode());
        var missingJson=missing.ToJsonString();
        var repaired=ChromeBookmarkSync.Apply(missingJson,install.Mutate(missingJson,BookmarkOperation.InstallOrRepair,Now),Now);
        Check(Records(JsonNode.Parse(repaired.Json)!.AsObject()).ContainsKey(Id(folder)),"Earlier untracked owned folder was not repaired");

        var foreign=JsonNode.Parse(first.Json)!.AsObject(); var foreignModel=Model(foreign);
        foreignModel.RemoveRaw(foreignModel.Fields(2).Single(f=>ChromeSyncMessage.Parse(f.Data).Number(1)==4));
        foreign["sync_metadata"]=Convert.ToBase64String(foreignModel.Encode());
        Fails(()=>ChromeBookmarkSync.Apply(foreign.ToJsonString(),install.Mutate(foreign.ToJsonString(),BookmarkOperation.InstallOrRepair,Now),Now),"Foreign untracked nodes were silently repaired");
        var noSync=Seed();noSync.Remove("sync_metadata");var rawLocal=noSync.ToJsonString();var localMutation=install.Mutate(rawLocal,BookmarkOperation.InstallOrRepair,Now);
        Check(ChromeBookmarkSync.Apply(rawLocal,localMutation,Now).Json==localMutation.Json,"Unsigned local store unexpectedly gained sync metadata");

        // Relocation changes the selected folder, not the destination's other children.
        var relocation = new BookmarkFileEditor(Package("1.1.0"), target:target with {
            ManagedFolderGuid=first.ManagedFolderGuid, ParentGuid=Bar(restoredDoc)[1]!["guid"]!.GetValue<string>(),
            FolderName="Renamed 云", PlacementPending=true });
        var relocated=ChromeBookmarkSync.Apply(restored.Json,relocation.Mutate(restored.Json,BookmarkOperation.InstallOrRepair,Now),Now);
        var relocatedDoc=JsonNode.Parse(relocated.Json)!.AsObject();AssertOrder(relocatedDoc);
        Check(Find(relocatedDoc,first.ManagedFolderGuid)["name"]!.GetValue<string>()=="Renamed 云","Relocation did not preserve requested name");
        foreach(var (id,raw) in originalRecords) Check(raw.SequenceEqual(Records(relocatedDoc)[id]),"Relocation modified unrelated sync records");

        var stale=JsonNode.Parse(first.Json)!.AsObject();
        ChangeMetadata(stale,Id(folder),m=>{m.SetText(9,"old offline hash");m.SetBytes(777,[9,8,7]);});
        var staleJson=stale.ToJsonString();
        var corrected=ChromeBookmarkSync.Apply(staleJson,install.Mutate(staleJson,BookmarkOperation.InstallOrRepair,Now),Now);
        var correctedDoc=JsonNode.Parse(corrected.Json)!.AsObject();
        Check(corrected.Changed && Meta(correctedDoc,Id(folder)).Bytes(777)!.SequenceEqual(new byte[]{9,8,7}),"Repair lost changed-entity unknown data");
        Check(!ChromeBookmarkSync.Apply(corrected.Json,install.Mutate(corrected.Json,BookmarkOperation.InstallOrRepair,Now),Now).Changed,"Metadata-only repair is not idempotent");
        var testEditor=new BookmarkTestFileEditor(Package("1.0.0"),"Isolated managed test");
        var testInstall=ChromeBookmarkSync.Apply(original,testEditor.Mutate(original,BookmarkOperation.InstallOrRepair,Now),Now);
        var testDoc=JsonNode.Parse(testInstall.Json)!.AsObject();AssertOrder(testDoc);
        Check(Records(testDoc).Count==originalRecords.Count+2,"Standalone test installer omitted sync records");
        foreach(var (id,raw) in originalRecords) Check(raw.SequenceEqual(Records(testDoc)[id]),"Test installer altered unrelated metadata");
        Check(!ChromeBookmarkSync.Apply(testInstall.Json,testEditor.Mutate(testInstall.Json,BookmarkOperation.InstallOrRepair,Now),Now).Changed,"Test installer sync is not idempotent");
        RunTransactions(original,install);
        return _checks;
    }

    private static void RunTransactions(string original, BookmarkFileEditor editor)
    {
        var project=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"../../../../../.."));
        if (!File.Exists(Path.Combine(project,"AGENTS.md"))) throw new InvalidOperationException("Unexpected test root");
        var scope=Path.Combine(project,"manager",".test-temp","bookmark-sync-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scope);
        try
        {
            var stores=new[]{"Bookmarks","Bookmarks Account"}.Select(name=>new BookmarkStore("Default","Isolated",name,Path.Combine(scope,name))).ToArray();
            foreach(var store in stores) File.WriteAllText(store.Path,original,new UTF8Encoding(false));
            var transaction=new BookmarkTransaction(editor,Path.Combine(scope,"Backups"));
            transaction.BeforeWriteForTests=(index,_)=>{if(index==1)throw new IOException("injected sync transaction failure");};
            try { transaction.Execute(stores,BookmarkOperation.InstallOrRepair,Now);throw new Exception("Expected rollback"); }
            catch(InvalidOperationException ex) when(ex.Message.Contains("restored",StringComparison.Ordinal)) {_checks++;}
            Check(stores.All(s=>File.ReadAllText(s.Path)==original),"Rollback did not restore sync metadata and tree together");
            transaction.BeforeWriteForTests=null;
            for(var index=0;index<3;index++)
            {
                var result=transaction.Execute(stores,index%2==0?BookmarkOperation.InstallOrRepair:BookmarkOperation.Remove,Now.AddMinutes(index));
                Check(result.Stores.All(s=>s.Mutation.Changed),"Sync transaction did not write both stores");
            }
            Check(Directory.GetDirectories(Path.Combine(scope,"Backups")).Length==2,"Sync changes bypassed two-backup retention");
            var before=stores.Select(s=>File.ReadAllBytes(s.Path)).ToArray();
            var invalid=JsonNode.Parse(original)!.AsObject();invalid["sync_metadata"]="broken-base64";
            File.WriteAllText(stores[1].Path,invalid.ToJsonString(),new UTF8Encoding(false));
            try { transaction.Execute(stores,BookmarkOperation.Remove,Now);throw new Exception("Expected invalid metadata failure"); }
            catch(InvalidDataException) {_checks++;}
            Check(File.ReadAllBytes(stores[0].Path).SequenceEqual(before[0]),"Preflight failure partially wrote a valid store");
        }
        finally { Directory.Delete(scope,true); }
    }

    internal static string BrowserFixture(bool corrected)
    {
        var original=Seed().ToJsonString();
        var editor=new BookmarkFileEditor(Package("1.0.0"),target:BookmarkInstallTarget.Default() with {InstallationId="isolated-browser-test"});
        var mutation=editor.Mutate(original,BookmarkOperation.InstallOrRepair,Now);
        return corrected?ChromeBookmarkSync.Apply(original,mutation,Now).Json:mutation.Json;
    }

    internal static JsonObject Seed()
    {
        var bar=Folder(1,"书签栏","00000000-0000-4000-a000-000000000002");
        var other=Folder(2,"其他书签","00000000-0000-4000-a000-000000000003");
        var mobile=Folder(3,"移动设备书签","00000000-0000-4000-a000-000000000004");
        bar["children"]!.AsArray().Add(Folder(4,"Unrelated folder"));
        bar["children"]!.AsArray().Add(Folder(5,"书签测试"));
        var doc=new JsonObject { ["version"]=1,["roots"]=new JsonObject{["bookmark_bar"]=bar,["other"]=other,["synced"]=mobile},["unknown_json"]="preserve" };
        var state=new ChromeSyncMessage();state.SetText(5,"isolated-not-an-account");state.SetNumber(9,3);state.SetBytes(999,[7,8,9]);
        var model=new ChromeSyncMessage();model.SetBytes(1,state.Encode());model.SetNumber(6,1);model.SetBytes(888,[1,4,9]);
        foreach(var node in Walk(doc))
        {
            var guid=node["guid"]!.GetValue<string>();var tag=ChromeBookmarkSync.ClientTag(guid);var md=new ChromeSyncMessage();
            md.SetText(1,tag);md.SetText(2,"server-"+guid);md.SetNumber(3,0);md.SetNumber(4,3);md.SetNumber(5,3);md.SetNumber(6,20);md.SetNumber(7,1700000000000);md.SetNumber(8,1700000000000);
            var position=ChromeUniquePosition.Create(null,null,tag);
            if(Id(node)==4) position=ChromeUniquePosition.Create(null,null,"AAAA");
            if(Id(node)==5) position=ChromeUniquePosition.Create(ChromeUniquePosition.Read(MetaFromModel(model,4).Bytes(11)!),null,tag);
            md.SetText(9,Hash(ChromeBookmarkSync.Specifics(node,bar["guid"]!.GetValue<string>(),position)));md.SetBytes(11,position);md.SetFixed32(12,0);md.SetBytes(777,[3,2,1]);
            var rec=new ChromeSyncMessage();rec.SetNumber(1,Id(node));rec.SetBytes(2,md.Encode());rec.SetBytes(666,[5,4]);model.AddBytes(2,rec.Encode());
        }
        doc["sync_metadata"]=Convert.ToBase64String(model.Encode());Checksums(doc);return doc;
    }
    private static BookmarkPackage Package(string version)
    {
        var profiles=BookmarkProfiles.All;
        var variants=profiles.Select(profile=>new BookmarkDefinition("chatgpt","chatgpt:"+profile,profile,"ChatGPT","ChatGPT-Cloudig","ChatGPT",version,"fixture.js",new string('a',64),20,20,"javascript:console.log('中文 '+ '"+version+"');")).ToArray();
        return new BookmarkPackage("cloudig/bookmark-package","1.0.0",version,BookmarkProfiles.Light,profiles,[new BookmarkPlatform("chatgpt","ChatGPT","ChatGPT","ChatGPT",variants,new Dictionary<string,string>())],3,1);
    }
    private static JsonObject Folder(long id,string name,string? guid=null)=>new(){["id"]=id.ToString(),["guid"]=guid??Guid.NewGuid().ToString("D"),["name"]=name,["type"]="folder",["date_added"]="13380163200000000",["date_modified"]="13380163200000000",["children"]=new JsonArray()};
    private static long Id(JsonObject node)=>long.Parse(node["id"]!.GetValue<string>());
    private static JsonObject BarRoot(JsonObject doc)=>doc["roots"]!["bookmark_bar"]!.AsObject();
    private static JsonArray Bar(JsonObject doc)=>BarRoot(doc)["children"]!.AsArray();
    private static JsonObject Find(JsonObject doc,string guid)=>Walk(doc).Single(n=>n["guid"]!.GetValue<string>()==guid);
    private static IEnumerable<JsonObject> Walk(JsonObject doc)
    {
        IEnumerable<JsonObject> Visit(JsonObject n){yield return n;if(n["children"] is JsonArray cs)foreach(var c in cs.OfType<JsonObject>())foreach(var sub in Visit(c))yield return sub;}
        return new[]{"bookmark_bar","other","synced"}.SelectMany(key=>Visit(doc["roots"]![key]!.AsObject()));
    }
    private static ChromeSyncMessage Model(JsonObject doc)=>ChromeSyncMessage.Parse(Convert.FromBase64String(doc["sync_metadata"]!.GetValue<string>()));
    private static byte[] State(JsonObject doc)=>Model(doc).Bytes(1)!;
    private static ChromeSyncMessage MetaFromModel(ChromeSyncMessage model,long id)=>ChromeSyncMessage.Parse(ChromeSyncMessage.Parse(model.Fields(2).Single(f=>ChromeSyncMessage.Parse(f.Data).Number(1,-1)==id).Data).Bytes(2)!);
    private static ChromeSyncMessage Meta(JsonObject doc,long id)=>MetaFromModel(Model(doc),id);
    private static void ChangeMetadata(JsonObject doc,long id,Action<ChromeSyncMessage> change)
    {
        var model=Model(doc);var field=model.Fields(2).Single(f=>ChromeSyncMessage.Parse(f.Data).Number(1,-1)==id);
        var record=ChromeSyncMessage.Parse(field.Data);var meta=ChromeSyncMessage.Parse(record.Bytes(2)!);
        change(meta);record.SetBytes(2,meta.Encode());model.ReplaceRaw(field,record.Encode());doc["sync_metadata"]=Convert.ToBase64String(model.Encode());
    }
    private static Dictionary<long,byte[]> Records(JsonObject doc)=>Model(doc).Fields(2).Select(f=>(f,r:ChromeSyncMessage.Parse(f.Data))).Where(x=>x.r.Has(1)).ToDictionary(x=>x.r.Number(1),x=>x.f.Raw);
    private static string Hash(byte[] bytes)=>Convert.ToBase64String(SHA1.HashData(bytes));
    private static void Checksums(JsonObject doc){var hash=ChromeBookmarkChecksums.Compute(doc);doc["checksum"]=hash.Md5;doc["checksum_sha256"]=hash.Sha256;}
    private static void AssertOrder(JsonObject doc)
    {
        foreach(var node in Walk(doc))if(node["children"] is JsonArray children){byte[]? previous=null;foreach(var child in children.OfType<JsonObject>()){var value=ChromeUniquePosition.Read(Meta(doc,Id(child)).Bytes(11)!);Check(previous is null||ChromeUniquePosition.Compare(previous,value)<0,"Synced order differs from local order");previous=value;}}
    }
    private static void Fails(Action action,string message){try{action();}catch(InvalidDataException){_checks++;return;}throw new InvalidOperationException(message);}
}
