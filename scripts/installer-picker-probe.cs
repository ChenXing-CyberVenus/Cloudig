// A test-only private Windows desktop: never switches or sends input to the user's desktop.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class InstallerPickerProbe
{
    const int PickerReadyBudgetMs = 2000; // Local regression budget, not a promise for every PC.
    delegate bool EnumProc(IntPtr h, IntPtr data);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title; public int x,y,w,h,cx,cy,fill,flags;
        public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attrs);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] static extern IntPtr SetText(IntPtr h, uint msg, IntPtr w, string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] static extern IntPtr ReadText(IntPtr h, uint msg, IntPtr w, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup si, out ProcessInfo pi);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint timeout);
    static string Text(IntPtr h) {
        var b=new StringBuilder(4096);
        // GetWindowText cannot read another process's edit buffer; use WM_GETTEXT.
        if(Class(h).EndsWith("Edit",StringComparison.OrdinalIgnoreCase)) {IntPtr result;ReadText(h,0xD,new IntPtr(b.Capacity),b,2,1000,out result);}
        else GetWindowText(h,b,b.Capacity);
        return b.ToString();
    }
    static string Class(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
    static List<IntPtr> Tops(IntPtr d) { var a=new List<IntPtr>(); EnumDesktopWindows(d,(h,p)=>{a.Add(h);return true;},IntPtr.Zero);return a; }
    static List<IntPtr> Children(IntPtr h) { var a=new List<IntPtr>(); EnumChildWindows(h,(c,p)=>{a.Add(c);return true;},IntPtr.Zero);return a; }
    static IntPtr Find(IntPtr parent, string text) => Children(parent).FirstOrDefault(h=>IsWindowVisible(h)&&IsWindowEnabled(h)&&Text(h)==text);
    static IntPtr Browse(IntPtr parent) => Children(parent).FirstOrDefault(h=>IsWindowVisible(h)&&IsWindowEnabled(h)&&Class(h)=="TNewButton"&&(Text(h)=="B&rowse..."||Text(h)=="浏览(&R)..."));
    static void Click(IntPtr h) { if(h==IntPtr.Zero) throw new Exception("Required visible control missing"); PostMessage(h,0xF5,IntPtr.Zero,IntPtr.Zero); }
    static IntPtr Wait(Func<IntPtr> query, int ms, string label) {
        var sw=Stopwatch.StartNew(); while(sw.ElapsedMilliseconds<ms) { var h=query();if(h!=IntPtr.Zero)return h;Thread.Sleep(20); }
        throw new Exception("Timed out: "+label);
    }
    static void Dump(IntPtr d, string file) {
        File.WriteAllLines(file,Tops(d).SelectMany(h=>new[]{Class(h)+" | "+Text(h)}.Concat(Children(h).Where(IsWindowVisible).Select(c=>"  "+Class(c)+" #"+GetDlgCtrlID(c)+" | "+Text(c)))));
    }
    public static string Run(string installer,string root,string initialDir,string language,bool selectionTests) {
        Directory.CreateDirectory(root); var temp=Path.Combine(root,"temp");Directory.CreateDirectory(temp);
        string name="CloudigPickerTest-"+Guid.NewGuid().ToString("N");
        File.WriteAllText(Path.Combine(root,"desktop.txt"),name);
        var desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01FF,IntPtr.Zero);
        if(desktop==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();
        var si=new Startup{cb=Marshal.SizeOf(typeof(Startup)),desktop=name}; ProcessInfo pi=new ProcessInfo();
        string oldTemp=Environment.GetEnvironmentVariable("TEMP"),oldTmp=Environment.GetEnvironmentVariable("TMP");
        var results=new List<string>();
        try {
            Environment.SetEnvironmentVariable("TEMP",temp); Environment.SetEnvironmentVariable("TMP",temp);
            string log=Path.Combine(root,"setup.log");
            var cmd=new StringBuilder("\""+installer+"\" /SP- /LANG="+language+" /NORESTART /LOG=\""+log+"\" /DIR=\""+initialDir+"\"");
            if(!CreateProcess(installer,cmd,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,root,ref si,out pi))throw new System.ComponentModel.Win32Exception();
            var wizard=Wait(()=>Tops(desktop).FirstOrDefault(h=>Class(h)=="TWizardForm"&&IsWindowVisible(h)),30000,"wizard");
            Dump(desktop,Path.Combine(root,"initial.txt"));
            // Advance only recognized pre-install pages. This probe never presses Install.
            for(int n=0;n<5&&Browse(wizard)==IntPtr.Zero;n++) {
                if(Children(wizard).Any(h=>Class(h)=="TNewPathEdit"&&IsWindowVisible(h)))throw new Exception("Unrecognized destination controls; refuse Next");
                var agree=Find(wizard,language=="zh"?"我同意此协议(&A)":"I &accept the agreement");if(agree!=IntPtr.Zero){Click(agree);Thread.Sleep(100);}
                var next=Children(wizard).FirstOrDefault(h=>Class(h)=="TNewButton"&&IsWindowVisible(h)&&IsWindowEnabled(h)&&(Text(h)=="&Next"||Text(h).StartsWith("下一步(&N)")));
                if(next==IntPtr.Zero)throw new Exception("Unexpected wizard page; see snapshot");
                Click(next);Thread.Sleep(150);
            }
            Dump(desktop,Path.Combine(root,"destination.txt"));
            var browse=Browse(wizard); if(browse==IntPtr.Zero)throw new Exception("Browse button missing");
            for(int i=0;i<2;i++) {
                var before=Children(wizard).Where(h=>Class(h)=="TNewPathEdit"&&IsWindowVisible(h)).Select(Text).Single();
                var sw=Stopwatch.StartNew();Click(browse);
                var dialog=Wait(()=>Tops(desktop).FirstOrDefault(h=>h!=wizard&&IsWindowVisible(h)&&(Class(h)=="TSelectFolderForm"||Class(h)=="#32770")),60000,"folder picker");
                long visible=sw.ElapsedMilliseconds;
                IntPtr result; bool responsive=SendMessageTimeout(dialog,0,IntPtr.Zero,IntPtr.Zero,2,1000,out result)!=IntPtr.Zero;
                Dump(desktop,Path.Combine(root,"picker-"+i+".txt"));
                results.Add("open="+i+" visible_ms="+visible+" responsive="+responsive+" class="+Class(dialog));
                File.WriteAllLines(Path.Combine(root,"timings.txt"),results);
                if(!responsive||visible>PickerReadyBudgetMs)throw new Exception("Picker responsiveness budget exceeded");
                PostMessage(dialog,0x10,IntPtr.Zero,IntPtr.Zero);
                Wait(()=>!IsWindow(dialog)||!IsWindowVisible(dialog)?wizard:IntPtr.Zero,10000,"cancel picker");
                var after=Children(wizard).Where(h=>Class(h)=="TNewPathEdit"&&IsWindowVisible(h)).Select(Text).Single();
                if(before!=after)throw new Exception("Cancel changed destination");
                results.Add("cancel_preserves_path=true");
            }
            if(selectionTests) {
                var choices=new[]{Path.Combine(root,"中文 空格"),Path.Combine(root,"已选","Cloudig"),Path.Combine(root,"已有 改名程序")};
                foreach(var choice in choices)Directory.CreateDirectory(choice);
                File.WriteAllText(Path.Combine(choices[2],"Cloudig.exe"),"test sentinel, never executable");
                foreach(var choice in choices) {
                    Click(browse);
                    var dialog=Wait(()=>Tops(desktop).FirstOrDefault(h=>Class(h)=="#32770"&&IsWindowVisible(h)&&Text(h)==(language=="zh"?"选择采云所在文件夹":"Choose the Cloudig folder")),10000,"modern picker");
                    var edit=Wait(()=>Children(dialog).FirstOrDefault(h=>Class(h)=="Edit"&&GetDlgCtrlID(h)==1152&&IsWindowVisible(h)),10000,"folder name field");
                    IntPtr result;
                    if(SetText(edit,0xC,IntPtr.Zero,"",2,1000,out result)==IntPtr.Zero)throw new Exception("Folder entry unresponsive");
                    foreach(char ch in choice)PostMessage(edit,0x102,new IntPtr(ch),IntPtr.Zero);
                    Wait(()=>Text(edit)==choice?edit:IntPtr.Zero,3000,"typed folder name");
                    Thread.Sleep(150);
                    Dump(desktop,Path.Combine(root,"select-"+Array.IndexOf(choices,choice)+".txt"));
                    var choose=Children(dialog).Single(h=>Class(h)=="Button"&&GetDlgCtrlID(h)==1&&IsWindowVisible(h));
                    Click(choose);
                    Wait(()=>!IsWindow(dialog)||!IsWindowVisible(dialog)?wizard:IntPtr.Zero,10000,"confirm folder");
                    Thread.Sleep(50);
                    var actual=Children(wizard).Where(h=>Class(h)=="TNewPathEdit"&&IsWindowVisible(h)).Select(Text).Single();
                    string expected=choice==choices[0]?Path.Combine(choice,"Cloudig"):choice;
                    if(actual!=expected)throw new Exception("Wrong destination: "+actual+" expected "+expected);
                    results.Add("selected="+actual);
                    File.WriteAllLines(Path.Combine(root,"timings.txt"),results);
                }
            }
            return String.Join("\n",results);
        } catch { Dump(desktop,Path.Combine(root,"failure.txt"));throw; } finally {
            Environment.SetEnvironmentVariable("TEMP",oldTemp);Environment.SetEnvironmentVariable("TMP",oldTmp);
            // Close this desktop's picker first, then the wizard and its exit question.
            for(int n=0;n<40&&pi.process!=IntPtr.Zero&&WaitForSingleObject(pi.process,0)!=0;n++) {
                var dialogs=Tops(desktop).Where(h=>IsWindowVisible(h)&&(Class(h)=="#32770"||Class(h)=="TSelectFolderForm")).ToArray();
                if(dialogs.Length>0) foreach(var h in dialogs) {
                    bool exit=Text(h)=="Exit Setup"||Text(h)=="退出安装程序";
                    var button=Children(h).FirstOrDefault(c=>Class(c)=="Button"&&GetDlgCtrlID(c)==(exit?6:2));
                    if(button==IntPtr.Zero&&!exit)button=Children(h).FirstOrDefault(c=>Class(c)=="Button"&&GetDlgCtrlID(c)==7);
                    if(button!=IntPtr.Zero)Click(button); else PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
                } else foreach(var h in Tops(desktop).Where(h=>Class(h)=="TWizardForm"))PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
                Thread.Sleep(100);
            }
            bool exited=pi.process==IntPtr.Zero||WaitForSingleObject(pi.process,0)==0;
            results.Add("installer_exited="+exited);
            if(pi.process!=IntPtr.Zero){CloseHandle(pi.process);CloseHandle(pi.thread);}
            Dump(desktop,Path.Combine(root,"final.txt"));CloseDesktop(desktop);
            File.WriteAllLines(Path.Combine(root,"timings.txt"),results);
            if(!exited)throw new Exception("Test installer still running; preserve scope for exact cleanup");
        }
    }
}
