using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Cloudig.Bookmarks;

internal static class ChromeManagerWindow
{
    private delegate bool EnumProc(nint handle,nint param);
    [DllImport("user32")] private static extern bool EnumDesktopWindows(nint desktop,EnumProc cb,nint param);
    [DllImport("kernel32")] private static extern uint GetCurrentThreadId();
    [DllImport("user32")] private static extern nint GetThreadDesktop(uint id);
    [DllImport("user32")] private static extern bool IsWindowVisible(nint h);
    [DllImport("user32",CharSet=CharSet.Unicode)] private static extern int GetClassName(nint h,StringBuilder s,int size);
    [DllImport("user32")] internal static extern uint GetWindowThreadProcessId(nint h,out int pid);
    [DllImport("user32",CharSet=CharSet.Unicode)] internal static extern int GetWindowText(nint h,StringBuilder s,int size);
    [DllImport("user32")] internal static extern bool PostMessage(nint h,uint msg,nint w,nint l);
    [DllImport("user32")] internal static extern uint MapVirtualKey(uint code,uint mapType);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X,Y; }
    [DllImport("user32")] private static extern nint SetThreadDpiAwarenessContext(nint value);
    [StructLayout(LayoutKind.Sequential)] private struct Rect {public int Left,Top,Right,Bottom;}
    [DllImport("user32")] private static extern bool GetWindowRect(nint window,out Rect rect);
    [DllImport("user32")] private static extern nint GetForegroundWindow();
    [DllImport("user32")] private static extern bool SetForegroundWindow(nint handle);
    [DllImport("user32")] private static extern bool IsIconic(nint handle);
    [DllImport("user32")] private static extern bool ShowWindowAsync(nint handle,int command);
    [DllImport("user32")] private static extern nint OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32")] private static extern bool CloseDesktop(nint desktop);
    [DllImport("user32",CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(nint h,int index,StringBuilder text,int length,out int needed);
    private static bool InteractiveDesktop(){
        var input=OpenInputDesktop(0,false,1);
        if(input==0)return false;
        try{
            var a=new StringBuilder(256);var b=new StringBuilder(256);
            return GetUserObjectInformation(input,2,a,512,out _) && GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,b,512,out _) && a.ToString()==b.ToString();
        }finally{CloseDesktop(input);}
    }
    internal static bool PrepareGesture(nint window)
    {
        if(!InteractiveDesktop())return false;
        if(IsIconic(window))ShowWindowAsync(window,9);
        if(GetForegroundWindow()!=window)SetForegroundWindow(window);
        for(int i=0;i<12;i++){
            if(!IsIconic(window) && GetForegroundWindow()==window)return true;
            Thread.Sleep(45);
        }
        Trace.WriteLine("Cloudig native bookmark placement: manager could not become foreground");
        return false;
    }
    [DllImport("user32")] private static extern nint WindowFromPoint(Point point);
    [DllImport("user32")] private static extern nint GetAncestor(nint window,uint flag);
    [DllImport("user32")] private static extern bool SetCursorPos(int x,int y);
    [DllImport("user32")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32")] private static extern short GetAsyncKeyState(int key);
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput {public int X,Y;public uint Data,Flags,Time;public nuint Extra;}
    [StructLayout(LayoutKind.Sequential)] private struct Input {public uint Type;public MouseInput Mouse;}
    [DllImport("user32")] private static extern uint SendInput(uint count,Input[] inputs,int size);
    internal static bool Drag(nint window,int sx,int sy,int dx,int dy,double[] accessibleWindow)
    {
        static bool Stop(string reason){Trace.WriteLine("Cloudig native bookmark placement: "+reason);return false;}
        if(!InteractiveDesktop())return Stop("noninteractive desktop");
        var oldDpi=SetThreadDpiAwarenessContext(-4);
        var down=false;var moved=false;
        GetCursorPos(out var original);
        bool Own(int x,int y)=>GetForegroundWindow()==window && GetAncestor(WindowFromPoint(new(){X=x,Y=y}),2)==window;
        static bool Button(uint flags)=>SendInput(1,[new(){Mouse=new(){Flags=flags}}],Marshal.SizeOf<Input>())==1;
        static bool Move(int x,int y){
            var left=GetSystemMetrics(76);var top=GetSystemMetrics(77);
            var width=GetSystemMetrics(78);var height=GetSystemMetrics(79);
            if(width<=0||height<=0)return false;
            var mx=(int)(((long)(x-left)*65536+32768)/width);
            var my=(int)(((long)(y-top)*65536+32768)/height);
            return SendInput(1,[new(){Mouse=new(){X=mx,Y=my,Flags=0xC001}}],Marshal.SizeOf<Input>())==1;
        }
        try {
            // Win32's input stream uses physical desktop pixels. Accessibility
            // may return logical screen coordinates in a differently scaled client.
            if(!GetWindowRect(window,out var bounds)||accessibleWindow.Length!=4||accessibleWindow[2]<=0||accessibleWindow[3]<=0)return false;
            int X(int x)=>(int)Math.Round(bounds.Left+(x-accessibleWindow[0])*(bounds.Right-bounds.Left)/accessibleWindow[2]);
            int Y(int y)=>(int)Math.Round(bounds.Top+(y-accessibleWindow[1])*(bounds.Bottom-bounds.Top)/accessibleWindow[3]);
            sx=X(sx);dx=X(dx);sy=Y(sy);dy=Y(dy);
            // A user-initiated install may drag only inside its own foreground
            // manager. Leave other windows, an active drag and modifier keys alone.
            if(GetForegroundWindow()!=window)return Stop("manager not foreground");
            if(!Own(sx,sy)||!Own(dx,dy)||new[]{1,2,4,16,17,18}.Any(k=>GetAsyncKeyState(k)<0))return Stop("point or input is not available");
            if(!SetCursorPos(sx,sy))return false;
            moved=true;Thread.Sleep(75);
            if(!Own(sx,sy) || !GetCursorPos(out var position) || position.X!=sx||position.Y!=sy)return false;
            down=Button(2);if(!down)return false;
            var lastX=sx;var lastY=sy;
            for(int i=1;i<=18;i++){
                Thread.Sleep(28);
                if(GetForegroundWindow()!=window || !GetCursorPos(out var actual) || actual.X!=lastX || actual.Y!=lastY)return Stop("gesture interrupted");
                lastX=sx+(dx-sx)*i/18;lastY=sy+(dy-sy)*i/18;
                if(!Move(lastX,lastY))return false;
            }
            Thread.Sleep(160);
            if(!Own(dx,dy))return Stop("drop point is not in manager");
            down=!Button(4);
            Thread.Sleep(250);
            Trace.WriteLine("Cloudig native bookmark placement: pointer released="+!down);
            return !down;
        } finally {
            if(down){PostMessage(window,0x100,27,1);Button(4);}
            if(moved && GetForegroundWindow()==window && GetCursorPos(out var end) && end.X==dx && end.Y==dy)SetCursorPos(original.X,original.Y);
            SetThreadDpiAwarenessContext(oldDpi);
        }
    }
    internal static List<nint> Windows(string executable){
        var list=new List<nint>();
        EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(h,_)=>{
            if(!IsWindowVisible(h))return true;
            var n=new StringBuilder(128);GetClassName(h,n,n.Capacity);if(n.ToString()!="Chrome_WidgetWin_1")return true;
            GetWindowThreadProcessId(h,out var pid);
            try{using var p=Process.GetProcessById(pid);if(string.Equals(p.MainModule?.FileName,executable,StringComparison.OrdinalIgnoreCase))list.Add(h);}catch(System.ComponentModel.Win32Exception){}catch(ArgumentException){}catch(InvalidOperationException){}
            return true;
        },0);
        return list;
    }
    internal static string Title(nint h){var b=new StringBuilder(512);GetWindowText(h,b,b.Capacity);return b.ToString();}
}
