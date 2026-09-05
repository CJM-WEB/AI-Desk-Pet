using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// 单次命令的内核归属边界：目标创建时加入 Job，控制流不经过目标标准流。
internal static class WindowsJobHelper {
  [StructLayout(LayoutKind.Sequential)] struct Limits { public long UserTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public Limits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUser, TotalKernel, PeriodUser, PeriodKernel; public uint PageFaults, TotalProcesses, ActiveProcesses, Terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public int cb; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short Show,Reserved2; public IntPtr ReservedPtr,Stdin,Stdout,Stderr; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static void Send(StreamWriter writer, JavaScriptSerializer json, object value) { writer.WriteLine(json.Serialize(value)); writer.Flush(); }
  // 不以根 PID 重建树；终止和确认都只使用本实例仍持有的 Job 句柄。
  static void Cleanup(IntPtr job) {
    Check(TerminateJobObject(job, 1), "TerminateJobObject");
    Stopwatch clock = Stopwatch.StartNew();
    while (clock.ElapsedMilliseconds < 4000) {
      Accounting info; Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
      if (info.ActiveProcesses == 0) return;
      Thread.Sleep(10);
    }
    throw new TimeoutException("Job 活动进程未归零");
  }
  static string ReadBounded(StreamReader reader) {
    StringBuilder line = new StringBuilder();
    for (int count = 0; count < 262144; count++) { int c = reader.Read(); if (c < 0) throw new EndOfStreamException("控制通道已断开"); if (c == 10) return line.ToString(); line.Append((char)c); }
    throw new InvalidDataException("控制消息超过上限");
  }
  public static int Main(string[] args) {
    if (args.Length != 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], "^aipet-job-[a-f0-9]{32}$")) return 70;
    IntPtr job = IntPtr.Zero; ProcessInfo process = new ProcessInfo(); StreamWriter writer = null; JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 262144;
    try {
      PipeSecurity security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
      security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
      using (NamedPipeServerStream pipe = new NamedPipeServerStream(args[0], PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security)) {
        IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
        if (!connection.AsyncWaitHandle.WaitOne(5000)) throw new TimeoutException("宿主未连接");
        pipe.EndWaitForConnection(connection);
        using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
        using (writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
          Task<string> startup = Task.Factory.StartNew(() => ReadBounded(reader));
          if (!startup.Wait(5000)) throw new TimeoutException("未收到启动参数");
          var input = json.Deserialize<Dictionary<string, object>>(startup.Result);
          string executable = (string)input["executable"], commandLine = (string)input["commandLine"], cwd = (string)input["cwd"];
          if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd)) throw new InvalidDataException("启动路径必须固定");
          job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
          ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE，禁止 breakaway。
          Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
          StartupInfoEx si = new StartupInfoEx(); si.Info.cb = Marshal.SizeOf(typeof(StartupInfoEx)); si.Info.Flags = 0x100 | 1; si.Info.Show = 0;
          si.Info.Stdin = CreateFileW("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
          si.Info.Stdout = GetStdHandle(-11); si.Info.Stderr = GetStdHandle(-12);
          IntPtr attributeSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
          si.Attributes = Marshal.AllocHGlobal(attributeSize); IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size); IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3); IntPtr environment = IntPtr.Zero;
          try {
            Check(InitializeProcThreadAttributeList(si.Attributes, 2, 0, ref attributeSize), "InitializeProcThreadAttributeList");
            Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(si.Attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "JOB_LIST");
            IntPtr[] io = { si.Info.Stdin, si.Info.Stdout, si.Info.Stderr };
            for (int i=0;i<io.Length;i++) { Check(SetHandleInformation(io[i], 1, 1), "SetHandleInformation"); Marshal.WriteIntPtr(handles, i*IntPtr.Size, io[i]); }
            Check(UpdateProcThreadAttribute(si.Attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "HANDLE_LIST");
            var env = (Dictionary<string, object>)input["env"]; var keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); StringBuilder block = new StringBuilder();
            foreach (string key in keys) { if (key.IndexOf('\0') >= 0 || key.IndexOf('=') >= 0) throw new InvalidDataException("环境键不允许"); string value = Convert.ToString(env[key]); if (value.IndexOf('\0') >= 0) throw new InvalidDataException("环境值不允许"); block.Append(key).Append('=').Append(value).Append('\0'); }
            block.Append('\0'); environment = Marshal.StringToHGlobalUni(block.ToString());
            Check(CreateProcessW(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x00080000 | 0x00000400, environment, cwd, ref si, out process), "CreateProcessW");
          } finally { DeleteProcThreadAttributeList(si.Attributes); Marshal.FreeHGlobal(si.Attributes); Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(handles); if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment); CloseHandle(si.Info.Stdin); }
          CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
          Send(writer, json, new { type = "ready", pid = process.Pid });
          Task<string> control = Task.Factory.StartNew(() => ReadBounded(reader)); bool cancelled = false;
          while (WaitForSingleObject(process.Process, 10) == 258) {
            if (!control.IsCompleted) continue;
            var message = json.Deserialize<Dictionary<string, object>>(control.Result);
            if ((string)message["type"] != "cancel") throw new InvalidDataException("不支持的控制消息");
            cancelled = true; break;
          }
          uint exit;
          if (!cancelled) { Check(GetExitCodeProcess(process.Process, out exit), "GetExitCodeProcess"); Send(writer, json, new { type = "root_exit", exit = exit }); }
          Cleanup(job);
          Check(GetExitCodeProcess(process.Process, out exit), "GetExitCodeProcess");
          Send(writer, json, new { type = "settled", exit = exit, activeProcesses = 0, cancelled = cancelled });
          return 0;
        }
      }
    } catch (Exception error) {
      string message = error.GetBaseException().Message;
      if (job != IntPtr.Zero) { try { Cleanup(job); } catch (Exception cleanup) { message += "; " + cleanup.Message; } }
      try { if (writer != null) Send(writer, json, new { type = "cleanup_failed", message = message }); } catch { }
      return 71;
    } finally { if (process.Process != IntPtr.Zero) CloseHandle(process.Process); if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread); if (job != IntPtr.Zero) CloseHandle(job); }
  }
}
