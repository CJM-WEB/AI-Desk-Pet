using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

// 原生回调只提供物理屏幕坐标；不检查窗口正文、不监听键盘、不阻止原鼠标消息。
public static class ChatPointerObserver
{
    private const int WhMouseLl = 14;
    private const int OutputCapacity = 64;
    private const uint QsAllInput = 0x04FF;
    private const uint MwmoInputAvailable = 0x0004;
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseData { public Point point; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint privateValue; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint milliseconds, uint wakeMask, uint flags);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static readonly ConcurrentQueue<string> Output = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent OutputReady = new AutoResetEvent(false);
    private static int outputCount;
    private static volatile bool outputFailed;
    private static readonly HookProc Callback = Observe;
    private static IntPtr hook;
    private static int generation;
    private static bool enabled;
    private static volatile bool eof;

    // 鼠标钩子和消息泵只入有界队列；stdout 背压只阻塞独立写出线程。
    private static void Publish(string line)
    {
        if (Interlocked.Increment(ref outputCount) > OutputCapacity)
        {
            Interlocked.Decrement(ref outputCount);
            outputFailed = true;
            return;
        }
        Output.Enqueue(line);
        OutputReady.Set();
    }

    private static IntPtr Observe(int code, IntPtr message, IntPtr data)
    {
        long kind = message.ToInt64();
        if (code >= 0 && enabled && (kind == 0x201 || kind == 0x204 || kind == 0x207 || kind == 0x20B))
        {
            MouseData mouse = (MouseData)Marshal.PtrToStructure(data, typeof(MouseData));
            Publish("{\"version\":1,\"type\":\"pointer-down\",\"generation\":" + generation + ",\"x\":" + mouse.point.x + ",\"y\":" + mouse.point.y + "}");
        }
        return CallNextHookEx(hook, code, message, data);
    }

    public static void Run()
    {
        Thread output = new Thread(() => {
            try
            {
                while (!eof)
                {
                    string line;
                    while (Output.TryDequeue(out line))
                    {
                        Interlocked.Decrement(ref outputCount);
                        Console.WriteLine(line);
                        Console.Out.Flush();
                    }
                    OutputReady.WaitOne(100);
                }
            }
            catch { outputFailed = true; }
        });
        output.IsBackground = true;
        output.Start();
        Thread input = new Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) Commands.Enqueue(line);
            eof = true;
        });
        input.IsBackground = true;
        input.Start();
        Stopwatch heartbeat = Stopwatch.StartNew();
        Publish("{\"version\":1,\"type\":\"ready\"}");
        try
        {
            while (!eof)
            {
                if (outputFailed) throw new InvalidOperationException();
                string command;
                while (Commands.TryDequeue(out command))
                {
                    if (command == "{\"version\":1,\"type\":\"shutdown\"}") return;
                    Match match = Regex.Match(command, "^\\{\"version\":1,\"type\":\"set-enabled\",\"enabled\":(true|false),\"generation\":([0-9]{1,10})\\}$");
                    int next;
                    if (!match.Success || !Int32.TryParse(match.Groups[2].Value, out next) || next <= generation) throw new InvalidOperationException();
                    enabled = false;
                    if (hook != IntPtr.Zero) { if (!UnhookWindowsHookEx(hook)) throw new InvalidOperationException(); hook = IntPtr.Zero; }
                    generation = next;
                    if (match.Groups[1].Value == "true")
                    {
                        hook = SetWindowsHookEx(WhMouseLl, Callback, GetModuleHandle(null), 0);
                        if (hook == IntPtr.Zero) throw new InvalidOperationException();
                        enabled = true;
                    }
                    Publish("{\"version\":1,\"type\":\"enabled\",\"generation\":" + generation + "}");
                }
                Message message;
                while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
                if (enabled && heartbeat.ElapsedMilliseconds >= 1000) { Publish("{\"version\":1,\"type\":\"heartbeat\"}"); heartbeat.Restart(); }
                // 低级鼠标钩子同步等待安装线程；普通休眠会阻塞全局输入，必须让新消息立即唤醒。
                // 保留原有命令/心跳轮询上限，已有未读消息也不能被漏掉。
                if (MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, 10, QsAllInput, MwmoInputAvailable) == UInt32.MaxValue)
                    throw new InvalidOperationException();
            }
        }
        finally { enabled = false; if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
    }
}
