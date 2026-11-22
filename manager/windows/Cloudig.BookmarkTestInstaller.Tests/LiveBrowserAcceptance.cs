using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

[SupportedOSPlatform("windows")]
internal static class LiveBrowserAcceptance
{
    [DllImport("user32")] static extern bool EnumDesktopWindows(nint desktop,EnumProc cb,nint param);
    [DllImport("kernel32")] static extern uint GetCurrentThreadId();
    [DllImport("user32")] static extern nint GetThreadDesktop(uint id);
    [DllImport("user32")] static extern bool EnumChildWindows(nint h,EnumProc cb,nint param);
    [DllImport("user32",CharSet=CharSet.Unicode)]static extern int GetClassName(nint h,System.Text.StringBuilder b,int count);
    [DllImport("user32",CharSet=CharSet.Unicode)]static extern nint SendMessageTimeout(nint h,uint m,nint size,System.Text.StringBuilder b,uint flags,uint ms,out nint len);
    static string DialogText(nint h){var texts=new List<string>();EnumChildWindows(h,(c,_)=>{var k=new System.Text.StringBuilder(80);GetClassName(c,k,80);if(k.ToString()=="Static"){var t=new System.Text.StringBuilder(4096);SendMessageTimeout(c,13,4096,t,2,1000,out var len);if(len>0)texts.Add(t.ToString());}return true;},0);return string.Join(" ",texts);}
    delegate bool EnumProc(nint h,nint x);
    static List<nint> Owned(int pid){var hs=new List<nint>();EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(h,_)=>{ChromeManagerWindow.GetWindowThreadProcessId(h,out var p);if(p==pid)hs.Add(h);return true;},0);return hs;}
    static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
    static void Wait(Func<bool> ok,string message,int ms=15000){var w=Stopwatch.StartNew();while(w.ElapsedMilliseconds<ms){if(ok())return;Thread.Sleep(80);}throw new Exception(message);}
    internal static void Run(string project,string root,string binary,string empty,bool editorProbe=false){
        Check(!Directory.Exists(root),"Not a fresh isolated directory");Directory.CreateDirectory(root);
        Console.WriteLine("isolated fixture: "+root);
        var chrome=LiveChromeEditor.Executable();var data=Path.Combine(root,"Data");var user=Path.Combine(root,"User Data");
        var file=Path.Combine(user,"Default","Bookmarks");Directory.CreateDirectory(Path.GetDirectoryName(file)!);File.WriteAllText(file,empty);
        var src=Path.Combine(project,"bookmarklets","candidate","test");var old=Path.Combine(root,"old");var packDir=Path.Combine(root,"package");var alternate=Path.Combine(root,"alternate");
        foreach(var dir in new[]{old,packDir,alternate})Directory.CreateDirectory(dir);
        var real=BookmarkTestDirectoryLoader.Load(src);
        foreach(var b in real.Bookmarks){
            var oldName=b.Artifact.Replace(b.Version,"0.0.1"+b.Version[b.Version.IndexOf('-')..]);
            File.WriteAllText(Path.Combine(old,oldName),"javascript:void(document.title='old:'+window.witness)");
            File.Copy(Path.Combine(src,b.Artifact),Path.Combine(packDir,b.Artifact));
            if(b.Id is "candidate-test-01-1" or "candidate-test-01-2"){
                var code="javascript:/*"+new string('x',480*1024-160)+"*/void(document.title='new:'+window.witness)";
                File.WriteAllText(Path.Combine(alternate,b.Artifact.Replace(b.Version,"99.0.0"+b.Version[b.Version.IndexOf('-')..])),code);
            }else File.Copy(Path.Combine(src,b.Artifact),Path.Combine(alternate,b.Artifact));
        }
        const string exe="Install.exe";foreach(var dir in new[]{packDir,alternate})File.Copy(binary,Path.Combine(dir,exe));
        var store=new BookmarkStore("Default","isolated","local",file);
        new BookmarkTransaction(new BookmarkTestFileEditor(BookmarkTestDirectoryLoader.Load(old)),Path.Combine(root,"seed")).Execute([store],BookmarkOperation.InstallOrRepair,DateTime.UtcNow);
        var j=JsonNode.Parse(File.ReadAllText(file))!.AsObject();var children=j["roots"]!["bookmark_bar"]!["children"]![0]!["children"]!.AsArray();
        children[^1]!["name"]="QA: keep my name";var extra=children[0]!.DeepClone().AsObject();extra.Remove("meta_info");extra["id"]="900";extra["guid"]=Guid.NewGuid().ToString();extra["name"]="QA unrelated";extra["url"]="https://example.invalid/untouched";children.Insert(1,extra);
        var sum=ChromeBookmarkChecksums.Compute(j);j["checksum"]=sum.Md5;j["checksum_sha256"]=sum.Sha256;File.WriteAllText(file,j.ToJsonString());
        File.WriteAllText(Path.Combine(user,"Default","Preferences"),"""{"bookmark_bar":{"show_on_all_tabs":true}}""");
        var before=LiveBookmarkSnapshot.Read(store);var witness=Path.Combine(root,"witness.html");
        File.WriteAllText(witness,"<meta charset=utf-8><title>loading</title><script>window.witness=crypto.randomUUID();document.title='witness:'+witness</script>");
        ProcessStartInfo Start(string exe,params string[] args){var x=new ProcessStartInfo(exe){UseShellExecute=false};foreach(var a in args)x.ArgumentList.Add(a);return x;}
        using var browser=QuietTestDesktop.Start(Start(chrome,"--no-first-run","--no-default-browser-check","--disable-sync","--disable-extensions","--disable-background-networking","--user-data-dir="+user,new Uri(witness).AbsoluteUri));
        var ax=new ChromeAccessibility();var backup=Path.Combine(data,"Device","BookmarkTestInstaller","Backups");
        string[] Structure()=>JsonNode.Parse(File.ReadAllText(file))!["roots"]!["bookmark_bar"]!["children"]!.AsArray().SelectMany(n=>new[]{(string)n!["guid"]!}.Concat(n["children"]!.AsArray().Select(o=>(string)o!["guid"]!))).ToArray();
        var order=Structure();
        string RunExe(string directory,bool undo=false){
            var si=Start(Path.Combine(directory,exe),"--data-root",data,"--chrome-user-data-dir",user);if(undo)si.ArgumentList.Add("--restore-last-live");
            using var p=QuietTestDesktop.Start(si);Console.WriteLine($"Started fixed EXE {p.Id}"+(undo?" (restore)":""));nint dlg=0;
            var idle=Stopwatch.StartNew();var stamp=File.GetLastWriteTimeUtc(file);
            Wait(()=>{if(p.HasExited)return true;
                var current=File.GetLastWriteTimeUtc(file);
                if(current!=stamp){stamp=current;idle.Restart();Console.WriteLine("Chrome saved: "+current.ToString("O"));}
                dlg=Owned(p.Id).FirstOrDefault(h=>ChromeManagerWindow.Title(h)=="安装当前书签测试"&&DialogText(h).Length>0);
                if(dlg==0&&idle.ElapsedMilliseconds>90000)throw new IOException("No Chrome save or installer result for 90s; phase="+directory);
                return dlg!=0;},"fixed EXE did not finish within the 12 minute cold-batch budget",720000);
            string message="";if(dlg!=0&&!p.HasExited){
                message=DialogText(dlg);Console.WriteLine("Result dialog: "+message);
                // On this Chrome/Windows host, MB_OK's only 确定 button can
                // have IDCANCEL (2), not IDOK (1). Never confirm a permission
                // or installation question. Dismiss only recognized results.
                Check(message.StartsWith("已在原位置")||message.StartsWith("书签已是目标版本")||message.StartsWith("书签测试安装失败"),"unexpected dialog: "+message);
                ChromeManagerWindow.PostMessage(dlg,0x10,0,0);
            }
            var exited=p.WaitForExit(7000);var errorLog=Path.Combine(data,"Device","BookmarkTestInstaller","last-live-error.txt");
            Check(exited&&p.ExitCode==0,"fixed EXE exit="+(exited?p.ExitCode.ToString():"still running")+": "+message+(File.Exists(errorLog)?File.ReadAllText(errorLog):""));
            Console.WriteLine(message);return message;
        }
        try{
            nint win=0;
            try{Wait(()=>{win=Owned(browser.Id).FirstOrDefault(h=>ChromeManagerWindow.Title(h).StartsWith("witness:"));return win!=0;},"isolated witness window",20000);}
            catch{Console.WriteLine("Fixture browser exit/status: "+browser.ExitCode+"; own windows: "+string.Join(" / ",Owned(browser.Id).Select(ChromeManagerWindow.Title).Where(t=>t.Length>0)));throw;}
            var title=ChromeManagerWindow.Title(win);var nonce=title["witness:".Length..].Split(" - ")[0];
            void ClickBookmark(string name,string expect){
                var h=ax.Window(win);ChromeAccessibility.Element? folder=null;
                Wait(()=>{folder=ax.Find(h,30003,50000).SingleOrDefault(e=>ChromeAccessibility.Name(e).Contains("书签测试"));return folder!=null;},
                    "isolated bookmark bar folder: "+string.Join(" / ",ax.Find(h,30003,50000).Select(ChromeAccessibility.Name)));
                ChromeAccessibility.OpenFolder(folder!);
                ChromeAccessibility.Element? item=null;
                Wait(()=>{foreach(var m in Owned(browser.Id)){try{item=ax.Find(ax.Window(m),30005,name).FirstOrDefault(e=>(int)e.Property(30003)==50011);if(item!=null)return true;}catch(COMException){}}return false;},"native bookmark menu: "+name);
                ChromeAccessibility.Click(item!);Wait(()=>ChromeManagerWindow.Title(win).StartsWith(expect+":"+nonce),"old document did not execute "+expect);
            }
            ClickBookmark(before.Items[0].Title,"old");
            if(editorProbe){
                var target=real.Bookmarks.MaxBy(b=>b.Characters)!;var n=before.Items.Single(x=>x.Slot==target.Id);
                var clock=Stopwatch.StartNew();
                using var editor=new LiveChromeEditor(chrome,user,"Default",before.FolderId,Path.Combine(root,"editor-probe"));
                editor.Edit(n,target.TitleZh,target.Url);
                Wait(()=>{try{var node=LiveBookmarkSnapshot.Read(store).Items.Single(x=>x.Guid==n.Guid);return node.Title==target.TitleZh&&LiveUpdate.Equivalent(node.Url,target.Url);}catch(IOException){return false;}},"full persisted probe",30000);
                var original=LiveBookmarkSnapshot.Read(store).Items.Single(x=>x.Guid==n.Guid);
                editor.Edit(original,"QA restore probe","javascript:void(0)");
                Wait(()=>{try{return LiveBookmarkSnapshot.Read(store).Items.Single(x=>x.Guid==n.Guid).Title=="QA restore probe";}catch(IOException){return false;}},"short probe persisted",30000);
                var small=LiveBookmarkSnapshot.Read(store).Items.Single(x=>x.Guid==n.Guid);
                editor.Edit(small,original.Title,original.Url);
                Wait(()=>{try{var restored=LiveBookmarkSnapshot.Read(store).Items.Single(x=>x.Guid==n.Guid);return restored.Title==original.Title&&restored.Url==original.Url;}catch(IOException){return false;}},"original stored URL restored exactly",30000);
                Console.WriteLine($"PASS targeted editor only: {target.Characters} chars, exact restoration of {original.Url.Length}-character stored URL, {clock.ElapsedMilliseconds} ms; not a fixed EXE acceptance.");return;
            }
            RunExe(packDir);
            var baseline=LiveBookmarkSnapshot.Read(store);
            void CheckReal(){
                var s=LiveBookmarkSnapshot.Read(store);Check(order.SequenceEqual(Structure())&&s.FolderGuid==before.FolderGuid,"folder/node identity or position changed");
                foreach(var n in s.Items){var d=real.Bookmarks.Single(b=>b.Id==n.Slot);Check(LiveUpdate.Equivalent(n.Url,d.Url)&&n.Title==(n.Guid==before.Items[^1].Guid?"QA: keep my name":d.TitleZh),"changed slot: "+n.Slot);}
                var other=JsonNode.Parse(File.ReadAllText(file))!["roots"]!["bookmark_bar"]!["children"]![0]!["children"]![1]!;
                Check((string?)other["name"]=="QA unrelated"&&(string?)other["url"]=="https://example.invalid/untouched","unmanaged neighbor changed");
            }
            CheckReal();var initialHash=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)));var count=Directory.GetFiles(backup,"before.json.gz",SearchOption.AllDirectories).Length;
            RunExe(packDir);Check(initialHash==Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))&&count==Directory.GetFiles(backup,"before.json.gz",SearchOption.AllDirectories).Length,"noop wrote changes");
            try{LiveUpdate.Execute(BookmarkTestDirectoryLoader.Load(alternate),store,backup,chrome,false,i=>{if(i==2)throw new IOException("intentional interruption");});throw new Exception("fault did not interrupt");}
            catch(IOException fail)when(fail.Message.Contains("已核对为原值")){Console.WriteLine("verified injected rollback");}
            CheckReal();RunExe(alternate);var first=LiveBookmarkSnapshot.Read(store).Items[0];ClickBookmark(first.Title,"new");
            RunExe(alternate,true);CheckReal();
            Check(ChromeManagerWindow.Title(win).StartsWith("new:"+nonce)&&!browser.HasExited,"existing Chrome document or process replaced");
            Console.WriteLine($"PASS fixed EXE: {real.Bookmarks.Count} slots; max chars {real.Bookmarks.Max(a=>a.Characters)}; GUIDs/order/custom name/neighbor; warm-tab execution; no-op and both rollback paths.");
        }finally{
            foreach(var h in ChromeManagerWindow.Windows(chrome)){ChromeManagerWindow.GetWindowThreadProcessId(h,out var p);if(p==browser.Id)ChromeManagerWindow.PostMessage(h,0x10,0,0);}
            browser.WaitForExit(10000);
        }
    }
}
