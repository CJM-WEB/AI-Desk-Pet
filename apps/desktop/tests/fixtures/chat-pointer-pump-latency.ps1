# 独立性能回归：使用真实消息泵，不注入系统鼠标或启动桌宠。
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../../resources/windows/chat-pointer-observer.cs'
$source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
# 临时夹具只增加自有消息窗口与就绪信号，实际等待和消息派发执行生产代码。
$source = $source.Replace('Stopwatch heartbeat = Stopwatch.StartNew();', 'PumpBenchmark.CreateOwnWindow(); Stopwatch heartbeat = Stopwatch.StartNew();')
$source = $source.Replace('if (enabled && heartbeat.ElapsedMilliseconds >= 1000)', 'PumpBenchmark.Ready.Set(); if (enabled && heartbeat.ElapsedMilliseconds >= 1000)')
$source = $source.Replace('finally { enabled = false;', 'finally { PumpBenchmark.DestroyOwnWindow(); enabled = false;')

$probe = @'
// 只发送WM_NULL给本夹具隐藏消息窗口，不注入鼠标，不读取系统输入。
public static class PumpBenchmark {
  public static readonly System.Threading.ManualResetEvent Ready = new System.Threading.ManualResetEvent(false);
  private static readonly System.Collections.Concurrent.BlockingCollection<string> Lines = new System.Collections.Concurrent.BlockingCollection<string>();
  private static System.IntPtr window;
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
  private static extern System.IntPtr CreateWindowEx(uint ex, string kind, string name, uint style, int x, int y, int width, int height, System.IntPtr parent, System.IntPtr menu, System.IntPtr instance, System.IntPtr param);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool DestroyWindow(System.IntPtr value);
  [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
  private static extern System.IntPtr SendMessageTimeout(System.IntPtr value, uint message, System.UIntPtr w, System.IntPtr l, uint flags, uint timeout, out System.UIntPtr result);
  private sealed class QueueReader : System.IO.TextReader { public override string ReadLine() { return Lines.Take(); } }
  public static void CreateOwnWindow() {
    window = CreateWindowEx(0, "STATIC", "ChatPointerPumpFixture", 0, 0, 0, 0, 0, new System.IntPtr(-3), System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero);
    if (window == System.IntPtr.Zero) throw new System.Exception("PUMP_WINDOW_FAILED");
  }
  public static void DestroyOwnWindow() { if (window != System.IntPtr.Zero) DestroyWindow(window); }
  public static double[] Run() {
    System.Console.SetIn(new QueueReader());
    System.Exception failure = null;
    var thread = new System.Threading.Thread(() => { try { ChatPointerObserver.Run(); } catch (System.Exception error) { failure = error; Ready.Set(); } });
    thread.IsBackground = true; thread.Start();
    Lines.Add("{\"version\":1,\"type\":\"set-enabled\",\"enabled\":false,\"generation\":1}");
    try {
      if (!Ready.WaitOne(3000) || failure != null) throw new System.Exception("PUMP_NOT_READY", failure);
      var values = new double[40];
      for (int i = -5; i < values.Length; i++) {
        System.Threading.Thread.Sleep(1);
        var watch = System.Diagnostics.Stopwatch.StartNew(); System.UIntPtr result;
        if (SendMessageTimeout(window, 0, System.UIntPtr.Zero, System.IntPtr.Zero, 2, 1000, out result) == System.IntPtr.Zero) throw new System.Exception("PUMP_MESSAGE_TIMEOUT");
        if (i >= 0) values[i] = watch.Elapsed.TotalMilliseconds;
      }
      System.Array.Sort(values);
      return new double[] { values[20], values[38], values[39] };
    } finally {
      Lines.Add("{\"version\":1,\"type\":\"shutdown\"}");
      if (!thread.Join(1500)) throw new System.Exception("PUMP_SHUTDOWN_TIMEOUT");
      if (failure != null) throw new System.Exception("PUMP_FAILED", failure);
    }
  }
}
'@
Add-Type -TypeDefinition ($source + [Environment]::NewLine + $probe)
$values = [PumpBenchmark]::Run()
[Console]::WriteLine((ConvertTo-Json -Compress @{ mode = 'production'; samples = 40; p50Ms = $values[0]; p95Ms = $values[1]; maxMs = $values[2]; passed = ($values[1] -lt 5) }))
if ($values[1] -ge 5) { exit 1 }
