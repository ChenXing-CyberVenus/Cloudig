using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using E=Cloudig.Bookmarks.ChromeAccessibility.Element;

namespace Cloudig.Bookmarks;

internal sealed class LiveChromeEditor : IDisposable
{
    private readonly ChromeAccessibility ax=new();
    private readonly string managerUrl,markerUrl,markerFile;
    private readonly nint handle;
    private readonly int owner;
    private readonly bool defaultLocalBar;
    internal int BrowserPid=>owner;
    private E? managerDocument;
    private static string DocumentUrl(E e)=>e.Property(30045) as string ?? "";
    internal static T Wait<T>(Func<T?> read,string label,int ms=8000) where T:class {
        var clock=Stopwatch.StartNew();
        do {try{if(read() is {} value)return value;}catch(COMException){}Thread.Sleep(90);}while(clock.ElapsedMilliseconds<ms);
        throw new IOException("等待 Chrome "+label+"超时。");
    }
    private E? ExactDoc(string url) {
        ChromeManagerWindow.GetWindowThreadProcessId(handle,out var p);if(p!=owner)return null;
        var root=ax.Window(handle);var docs=ax.Find(root,30011,"RootWebArea");
        bool Match(string s)=>url==markerUrl ? Uri.TryCreate(s,UriKind.Absolute,out var u)&&u.IsFile&&string.Equals(u.LocalPath,markerFile,StringComparison.OrdinalIgnoreCase) : s==url || defaultLocalBar && s=="chrome://bookmarks/";
        var exact=docs.SingleOrDefault(e=>Match(DocumentUrl(e)));if(exact!=null)return exact;
        // UIA sometimes exposes the omnibox before Chromium's document value.
        // The file window must also bear our nonce; a typed URL alone is never
        // evidence of a committed navigation to the manager.
        var address=ax.Find(root,30011,"view_1012").SingleOrDefault();
        if(address==null||!Match(ChromeAccessibility.Value(address)))return null;
        if(url==markerUrl&&ChromeManagerWindow.Title(handle).StartsWith(Path.GetFileNameWithoutExtension(markerFile)+" - ",StringComparison.Ordinal))return root;
        return docs.SingleOrDefault(d=>ax.First(d,30011,"list")!=null||ax.First(d,30011,"saveButton")!=null||ax.First(d,30011,"wrapper")!=null);
    }
    private E Doc(){
        ChromeManagerWindow.GetWindowThreadProcessId(handle,out var p);
        if(p!=owner)throw new IOException("专用管理窗口已关闭。");
        // A document element is scoped to one navigation. Check its actual URL;
        // don't walk every 480 Ki bookmark row just to rediscover the document.
        if(managerDocument is {} d && (DocumentUrl(d)==managerUrl || defaultLocalBar && DocumentUrl(d)=="chrome://bookmarks/"))return d;
        // The selected local root is canonicalized after the first render.
        // Never use a different document during that navigation.
        return managerDocument=Wait(()=>ExactDoc(managerUrl),"选定的书签管理页面",4000);
    }
    internal static string Executable() {
        var options=new[]{Environment.SpecialFolder.LocalApplicationData,Environment.SpecialFolder.ProgramFiles,Environment.SpecialFolder.ProgramFilesX86}
            .Select(d=>Path.Combine(Environment.GetFolderPath(d),"Google","Chrome","Application","chrome.exe")).Where(File.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var active=options.Where(x=>ChromeManagerWindow.Windows(x).Count>0).ToArray();
        if(active.Length==1)return active[0];if(options.Length==1)return options[0];
        throw new IOException("无法唯一定位正在使用的 Google Chrome。");
    }
    internal LiveChromeEditor(string chrome,string userData,string profile,string folderId,string cache,int? previousOwner=null,bool defaultLocalBar=false)
    {
        managerUrl="chrome://bookmarks/?id="+folderId;
        this.defaultLocalBar=defaultLocalBar;
        Directory.CreateDirectory(cache);var tag="Cloudig-"+Guid.NewGuid().ToString("N");
        markerFile=Path.Combine(cache,tag+".html");markerUrl=new Uri(markerFile).AbsoluteUri;
        File.WriteAllText(markerFile,"<!doctype html><meta charset=utf-8><title>"+tag+"</title>采云正在打开书签管理器，可保持原对话不动。",new UTF8Encoding(false));
        try{
            var old=ChromeManagerWindow.Windows(chrome).ToHashSet();
            if(previousOwner is int pid&&!old.Any(h=>{ChromeManagerWindow.GetWindowThreadProcessId(h,out var p);return p==pid;}))
                throw new IOException("原 Chrome 窗口已经关闭；保留还原备份，不重新启动浏览器。");
            var p=new ProcessStartInfo(chrome){UseShellExecute=false};
            foreach(var arg in new[]{"--new-window","--user-data-dir="+userData,"--profile-directory="+profile,markerUrl})p.ArgumentList.Add(arg);
            using var launched=Process.Start(p);
            handle=Wait(()=>ChromeManagerWindow.Windows(chrome).Where(h=>!old.Contains(h)&&ChromeManagerWindow.Title(h).StartsWith(tag+" - ",StringComparison.Ordinal)).Select(h=>new Handle(h)).SingleOrDefault(),"专用管理窗口",24000).Value;
            ChromeManagerWindow.GetWindowThreadProcessId(handle,out owner);
            if(previousOwner!=null&&owner!=previousOwner)throw new IOException("原 Chrome 已关闭，不在新的进程中继续还原。");
            // Unique nonce title, a newly created handle and the browser image
            // already identify this disposable window. Read its real omnibox
            // before entering any address; no operations target an existing tab.
            Wait(()=>ExactDoc(markerUrl),"本次窗口的身份标记",18000);
            var address=ax.Find(ax.Window(handle),30011,"view_1012").Single();
            address.Focus();ChromeAccessibility.Set(address,managerUrl);
            Wait(()=>ChromeAccessibility.Value(address)==managerUrl?address:null,"管理地址");
            Key(13);
            try {Wait(()=>ExactDoc(managerUrl),"正确的书签文件夹",18000);}
            catch(IOException error){
                var addresses=ax.Find(ax.Window(handle),30011,"RootWebArea").Select(DocumentUrl)
                    .Where(url=>url.StartsWith("chrome://bookmarks/",StringComparison.Ordinal));
                throw new IOException("书签管理器未打开目标 "+managerUrl+"；当前管理地址 "+string.Join(", ",addresses),error);
            }
        }catch{Dispose();throw;}
    }
    private sealed record Handle(nint Value);
    private void Key(int code){
        // No SendKeys / clipboard: even if the user switches apps, both messages
        // are delivered only to the uniquely identified installer-owned window.
        int scan=(int)ChromeManagerWindow.MapVirtualKey((uint)code,0)<<16;
        if(!ChromeManagerWindow.PostMessage(handle,0x100,code,1|scan)||
           !ChromeManagerWindow.PostMessage(handle,0x101,code,unchecked((int)0xc0000001)|scan))throw new IOException("管理窗口不再可用。");
    }
    private E Row(LiveBookmark b){
        return Row(b.Index,b.Title);
    }
    private E Row(int index,string title){
        E? Find()=>ax.First(Doc(),30011,"bookmark_"+index);
        var row=Find();for(var step=0;row==null && step<12;step++){
            var list=ax.Find(Doc(),30011,"list").Single();
            var rows=ax.Find(list,30003,50029);
            if(rows.Count==0)throw new IOException("Chrome 未显示书签列表。");
            var first=ChromeAccessibility.Id(rows[0]);
            var edge=first.StartsWith("bookmark_")&&int.TryParse(first.AsSpan(9),out var lo)&&index<lo?rows[0]:rows[^1];
            ChromeAccessibility.ScrollItem(edge);Thread.Sleep(180);row=Find();
        }
        if(row==null||ChromeAccessibility.Name(row)!=title)throw new IOException("文件夹中的书签位置或原名称已变化："+title);
        return row;
    }
    private void MenuCommand(E menu,params string[] names)
    {
        if(ax.Find(ax.Window(handle),30003,50019).Count!=1)throw new IOException("专用管理窗口多了其他标签。");
        ChromeAccessibility.OpenFolder(menu);
        var commands=Wait(()=>{var found=ax.Find(Doc(),30003,50011);return found.Count>0?found:null;},"书签菜单");
        var command=commands.SingleOrDefault(item=>names.Contains(ChromeAccessibility.Name(item).Trim().TrimEnd('…','.').Trim(),StringComparer.OrdinalIgnoreCase));
        if(command==null)throw new IOException("未找到 Chrome 的书签操作："+names[0]+" ("+string.Join(", ",commands.Select(ChromeAccessibility.Name))+")");
        ChromeAccessibility.Click(command);
    }
    internal void Create(string name,string? url)
    {
        var menu=Wait(()=>{var doc=Doc();var toolbar=ax.First(doc,30011,"toolbar");
            return (toolbar==null?null:ax.First(toolbar,30011,"menuButton")) ?? ax.First(doc,30011,"menuButton");},"书签管理菜单");
        if(url==null)MenuCommand(menu,"Add new folder","Add folder","添加新文件夹","添加文件夹","新增資料夾");
        else MenuCommand(menu,"Add new bookmark","Add bookmark","添加新书签","添加书签","新增書籤");
        var fields=Wait(()=>{var f=ax.Find(Doc(),30011,"input");return f.Count==(url==null?1:2)?f:null;},"新建书签输入框");
        if(fields.Any(field=>ChromeAccessibility.Value(field).Length!=0))throw new IOException("所选对话框已有内容，停止新建。");
        ChromeAccessibility.Set(fields[0],name);
        if(url!=null)ChromeAccessibility.Set(fields[1],LiveUpdate.EditorSpelling(url));
        Wait(()=>ChromeAccessibility.Value(fields[0])==name && (url==null||MatchesField(ChromeAccessibility.Value(fields[1]),LiveUpdate.EditorSpelling(url)))?fields[0]:null,"新建书签值");
        SaveDialog();
    }
    internal void RenameFolder(int index,string oldName,string name)
    {
        var menu=ax.First(Row(index,oldName),30011,"menuButton")??throw new IOException("找不到文件夹菜单。");
        MenuCommand(menu,"Rename","重命名","重新命名");
        var field=Wait(()=>ax.Find(Doc(),30011,"input").SingleOrDefault(e=>ChromeAccessibility.Value(e)==oldName),"文件夹名称");
        ChromeAccessibility.Set(field,name);
        Wait(()=>ChromeAccessibility.Value(field)==name?field:null,"新的文件夹名称");
        SaveDialog();
    }
    internal bool MoveFirst(int index,string name,string firstName,bool uniqueName)
    {
        if(!ChromeManagerWindow.PrepareGesture(handle))return false;
        var first=Row(0,firstName);
        ChromeAccessibility.ScrollItem(first);
        var source=ax.First(Doc(),30011,"bookmark_"+index);
        if(source==null || source.Property(30022) is true || ChromeAccessibility.Name(source)!=name){
            if(!uniqueName)return false;
            var tree=ax.Find(Doc(),30003,50024).Where(n=>ChromeAccessibility.Name(n)==name).ToArray();
            if(tree.Length!=1){Trace.WriteLine("Cloudig native bookmark placement: folder not visible in tree");return false;}
            source=tree[0];ChromeAccessibility.ScrollItem(source);
        }
        if(source.Property(30022) is true || first.Property(30022) is true || ChromeAccessibility.Name(source)!=name ||
           ChromeAccessibility.Name(first)!=firstName || ChromeAccessibility.Id(first)!="bookmark_0")return false;
        var list=ax.First(Doc(),30011,"list");
        if(list==null || ax.Find(list,30079,true).Count>1 || ax.Find(ax.Window(handle),30003,50019).Count!=1)return false;
        static double[] Rect(E item)=>item.Property(30001) as double[] ?? throw new IOException("Chrome 未提供书签行的位置。");
        var a=Rect(source);var b=Rect(first);
        var sx=(int)(a[0]+a[2]*.40);var sy=(int)(a[1]+a[3]*.5);
        var dx=(int)(b[0]+b[2]*.40);var dy=(int)(b[1]+b[3]*.18);
        if(!ChromeManagerWindow.Drag(handle,sx,sy,dx,dy,Rect(ax.Window(handle))))return false;
        // Mouse-up enters Chrome's native drag loop asynchronously. Keep the
        // source document alive until its first row reflects the drop.
        for(int i=0;i<25;i++){
            if(ax.First(Doc(),30011,"bookmark_0") is {} top && ChromeAccessibility.Name(top)==name)return true;
            Thread.Sleep(80);
        }
        Trace.WriteLine("Cloudig native bookmark placement: original first row still visible");
        return false;
    }
    private void SaveDialog()
    {
        var save=ax.First(Doc(),30011,"saveButton")??throw new IOException("Chrome 原生编辑框尚无保存按钮。");
        ChromeAccessibility.Click(save);
        Wait(()=>ax.First(Doc(),30011,"saveButton")==null?"saved":null,"原生编辑框保存",16000);
    }
    private static bool MatchesField(string ui,string expected) {
        if(ui==expected)return true;
        // Chromium's accessibility value can expose only its first 9,990
        // characters. This is an identity check, never the full-write proof.
        bool clipped=Encoding.UTF8.GetByteCount(ui)>=9990;
        if(clipped && expected.StartsWith(ui,StringComparison.Ordinal))return true;
        if(!ui.StartsWith("javascript:",StringComparison.OrdinalIgnoreCase))return false;
        var actual=LiveUpdate.ScriptBytes(ui);var full=LiveUpdate.ScriptBytes(expected);
        return actual.AsSpan().SequenceEqual(full) || (clipped && actual.Length>4 && full.AsSpan().StartsWith(actual.AsSpan(0,actual.Length-4)));
    }
    internal void Edit(LiveBookmark from,string title,string url)
    {
        var input=LiveUpdate.EditorSpelling(url);
        if(ax.Find(ax.Window(handle),30003,50019).Count!=1)throw new IOException("专用更新窗口多了别的标签，未操作。");
        var row=Row(from);
        // Use the action belonging to this row. Native controls do not need
        // keyboard focus to invoke Edit or set its values. In particular, do
        // not bring Chrome back to the foreground for each of 32 items.
        var menu=ax.First(row,30011,"menuButton")??throw new IOException("找不到这个书签的操作菜单："+from.Slot);
        ChromeAccessibility.OpenFolder(menu);
        var commands=Wait(()=>{var a=ax.Find(Doc(),30003,50011);return a.Count>0?a:null;},"本书签操作菜单："+from.Slot);
        static bool IsEdit(string s)=>s.Trim().TrimEnd('…','.').Replace("(&E)","").Replace("(E)","").Trim() is "编辑" or "修改" or "編輯" or "Edit";
        var command=commands.SingleOrDefault(e=>IsEdit(ChromeAccessibility.Name(e)));
        if(command!=null)ChromeAccessibility.Click(command);
        else{
            // Other Chrome languages: use the native locale-independent Edit
            // shortcut only on an already selected, already focused owner row.
            Key(27);var r=Row(from);ChromeAccessibility.Click(r);
            Wait(()=>r.Property(30079) is true&&r.Property(30008) is true?r:null,"已选编辑行");
            if(ax.Find(ax.First(Doc(),30011,"list")!,30079,true).Count!=1)throw new IOException("书签不是单选。");
            Key(113);
        }
        var fields=Wait(()=>{var f=ax.Find(Doc(),30011,"input");return f.Count==2?f:null;},"原生编辑框："+from.Slot);
        var name=fields.Single(e=>ChromeAccessibility.Value(e)==from.Title);
        var link=fields.Single(e=>!ReferenceEquals(e,name)&&MatchesField(ChromeAccessibility.Value(e),from.Url));
        if(from.Title!=title){ChromeAccessibility.Set(name,title);Wait(()=>ChromeAccessibility.Value(name)==title?name:null,"名称："+from.Slot);}
        if(from.Url.Length>LiveUpdate.NativeInputLimit||!LiveUpdate.Equivalent(from.Url,url)){
            if(MatchesField(ChromeAccessibility.Value(link),input)){
                // Old and new bookmarklets may have the same visible prefix.
                // An unsaved draft marker orders the two asynchronous changes.
                const string draft="about:blank#cloudig-unsaved";
                ChromeAccessibility.Set(link,draft);Wait(()=>ChromeAccessibility.Value(link)==draft?link:null,"编辑框草稿");
            }
            ChromeAccessibility.Set(link,input);
        }
        try{Wait(()=>ChromeAccessibility.Value(name)==title&&MatchesField(ChromeAccessibility.Value(link),input)?link:null,"书签编辑值："+from.Slot);}
        catch(IOException e){var v=ChromeAccessibility.Value(link);int i=0;while(i<input.Length&&i<v.Length&&input[i]==v[i])i++;
            throw new IOException($"编辑框未确认：槽位 {from.Slot}，名称匹配={ChromeAccessibility.Value(name)==title}，网址可见 {v.Length} 字符，匹配前缀 {i} 字符；没有提交此项。",e);}
        var save=ax.First(Doc(),30011,"saveButton")??throw new IOException("Chrome 原生编辑框尚无保存按钮。");
        ChromeAccessibility.Click(save);
        Wait(()=>ax.First(Doc(),30011,"saveButton")==null?"saved":null,"编辑框保存："+from.Slot,16000);
    }
    public void Dispose(){
        try{if(handle!=0 && (ExactDoc(managerUrl)!=null||ExactDoc(markerUrl)!=null) && ax.Find(ax.Window(handle),30003,50019).Count==1)
            ChromeManagerWindow.PostMessage(handle,0x10,0,0);}catch(COMException){}catch(InvalidOperationException){}
        try{File.Delete(markerFile);}catch(IOException){}
    }
}
