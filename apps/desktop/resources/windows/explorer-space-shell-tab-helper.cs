using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace AiPet.ExplorerSpace
{
    public sealed class ExplorerObservationResult
    {
        public string Status { get; set; }
        public long Hwnd { get; set; }
        public string InstanceId { get; set; }
        public ExplorerRect Rect { get; set; }
    }

    public struct ExplorerRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    internal sealed class ExplorerSample
    {
        internal bool ComponentsAvailable;
        internal bool ForegroundIsExplorer;
        internal bool Minimized;
        internal bool Foreground;
        internal bool ProfileAccepted;
        internal bool RectAvailable;
        internal long OuterHwnd;
        internal long ActiveTabHwnd;
        internal uint ProcessId;
        internal long ProcessCreatedAt;
        internal ExplorerRect Rect;
    }

    internal sealed class ShellCandidate
    {
        internal long TabHwnd;
        internal Action Release;
    }

    internal interface IExplorerSystemAdapter : IDisposable
    {
        ExplorerSample Sample();
        IList<ShellCandidate> EnumerateCandidates(long outerHwnd);
    }

    /// <summary>精确候选身份与映射算法版本均为只读常量，生产永不自动提升。</summary>
    internal static class ExplorerCandidateProfile
    {
        internal const int OsMajor = 10;
        internal const int OsMinor = 0;
        internal const int OsBuild = 26200;
        internal const string ExplorerProductVersion = "10.0.26100.8875";
        internal const int ExplorerFileMajorPart = 10;
        internal const int ExplorerFileMinorPart = 0;
        internal const int ExplorerFileBuildPart = 26100;
        internal const int ExplorerFilePrivatePart = 8875;
        internal const string MappingVersion = "shell-tab-hwnd-v1";
        internal const bool ProductionVerified = true;

        internal static bool IsAcceptedReportedVersions(int major, int minor, int build,
            string productVersion, int fileMajorPart, int fileMinorPart, int fileBuildPart,
            int filePrivatePart, string mappingVersion)
        {
            return ProductionVerified &&
                major == OsMajor && minor == OsMinor && build == OsBuild &&
                String.Equals(productVersion, ExplorerProductVersion, StringComparison.Ordinal) &&
                fileMajorPart == ExplorerFileMajorPart && fileMinorPart == ExplorerFileMinorPart &&
                fileBuildPart == ExplorerFileBuildPart && filePrivatePart == ExplorerFilePrivatePart &&
                String.Equals(mappingVersion, MappingVersion, StringComparison.Ordinal);
        }
    }

    /// <summary>固定系统适配器与测试共用的纯决策核。</summary>
    internal static class ExplorerDecisionCore
    {
        internal static ExplorerObservationResult Observe(IExplorerSystemAdapter adapter)
        {
            IList<ShellCandidate> candidates = null;
            IList<ShellCandidate> endingCandidates = null;
            try
            {
                ExplorerSample before = adapter.Sample();
                if (!before.ForegroundIsExplorer || before.Minimized || !before.Foreground)
                    return Result("none");
                if (!before.ComponentsAvailable || !before.ProfileAccepted)
                    return Result("unavailable");
                if (!before.RectAvailable)
                    return Result("ambiguous");
                if (before.ActiveTabHwnd == 0)
                    return Result("ambiguous");

                candidates = adapter.EnumerateCandidates(before.OuterHwnd);
                ShellCandidate matched;
                if (!TryGetUniqueMapping(candidates, before.ActiveTabHwnd, out matched))
                    return Result("ambiguous");

                ExplorerSample after = adapter.Sample();
                if (!SameGeneration(before, after))
                    return Result("ambiguous");
                endingCandidates = adapter.EnumerateCandidates(after.OuterHwnd);
                ShellCandidate endingMatch;
                if (!TryGetUniqueMapping(endingCandidates, after.ActiveTabHwnd, out endingMatch))
                    return Result("ambiguous");

                return new ExplorerObservationResult
                {
                    Status = "ready",
                    Hwnd = before.OuterHwnd,
                    InstanceId = CreateInstanceId(before),
                    Rect = before.Rect
                };
            }
            catch (COMException)
            {
                return Result("unavailable");
            }
            catch (InvalidOperationException)
            {
                return Result("unavailable");
            }
            catch
            {
                return Result("unavailable");
            }
            finally
            {
                ReleaseCandidates(endingCandidates);
                ReleaseCandidates(candidates);
            }
        }

        private static bool TryGetUniqueMapping(IList<ShellCandidate> candidates, long activeTabHwnd,
            out ShellCandidate matched)
        {
            matched = null;
            int matches = 0;
            var seen = new HashSet<long>();
            foreach (ShellCandidate candidate in candidates)
            {
                if (!seen.Add(candidate.TabHwnd))
                    return false;
                if (candidate.TabHwnd != activeTabHwnd)
                    continue;
                matched = candidate;
                matches++;
            }
            return matches == 1 && matched != null;
        }

        private static void ReleaseCandidates(IList<ShellCandidate> candidates)
        {
            if (candidates == null) return;
            foreach (ShellCandidate candidate in candidates)
                if (candidate.Release != null) candidate.Release();
        }

        private static bool SameGeneration(ExplorerSample left, ExplorerSample right)
        {
            return right.ComponentsAvailable && right.ProfileAccepted && right.RectAvailable &&
                right.ForegroundIsExplorer && right.Foreground && !right.Minimized &&
                left.OuterHwnd == right.OuterHwnd &&
                left.ActiveTabHwnd == right.ActiveTabHwnd &&
                left.ProcessId == right.ProcessId &&
                left.ProcessCreatedAt == right.ProcessCreatedAt &&
                left.Rect.Left == right.Rect.Left && left.Rect.Top == right.Rect.Top &&
                left.Rect.Right == right.Rect.Right && left.Rect.Bottom == right.Rect.Bottom;
        }

        private static string CreateInstanceId(ExplorerSample sample)
        {
            string value = sample.ProcessId + ":" + sample.ProcessCreatedAt + ":" +
                sample.OuterHwnd + ":" + sample.ActiveTabHwnd;
            using (SHA256 hash = SHA256.Create())
            {
                byte[] bytes = hash.ComputeHash(Encoding.UTF8.GetBytes(value));
                var output = new StringBuilder(32);
                for (int index = 0; index < 16; index++)
                    output.Append(bytes[index].ToString("x2"));
                return output.ToString();
            }
        }

        internal static ExplorerObservationResult Result(string status)
        {
            return new ExplorerObservationResult { Status = status };
        }
    }

    /// <summary>生产入口固定为无参数调用；仅精确生产 profile 允许观察，未知身份始终失败关闭。</summary>
    public static class RestrictedExplorerShellTabObserver
    {
        private const int ObservationTimeoutMilliseconds = 1000;

        public static ExplorerObservationResult ObserveActiveExplorer()
        {
            ExplorerObservationResult result = null;
            var thread = new Thread(delegate()
            {
                try
                {
                    using (var adapter = new WindowsExplorerSystemAdapter())
                        result = ExplorerDecisionCore.Observe(adapter);
                }
                catch
                {
                    result = ExplorerDecisionCore.Result("unavailable");
                }
            });
            thread.IsBackground = true;
            thread.Name = "ExplorerShellTabObserver";
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            if (!thread.Join(ObservationTimeoutMilliseconds))
                return ExplorerDecisionCore.Result("unavailable");
            return result ?? ExplorerDecisionCore.Result("unavailable");
        }
    }

    /// <summary>仅封装白名单中的窗口、进程和固定 Shell COM 操作。</summary>
    internal sealed class WindowsExplorerSystemAdapter : IExplorerSystemAdapter
    {
        private object shellApplication;
        private object shellWindows;

        internal WindowsExplorerSystemAdapter() { }

        public ExplorerSample Sample()
        {
            IntPtr outer = NativeMethods.GetForegroundWindow();
            if (outer == IntPtr.Zero)
                return new ExplorerSample { ComponentsAvailable = true };

            uint processId;
            NativeMethods.GetWindowThreadProcessId(outer, out processId);
            bool isExplorer = IsVerifiedExplorer(outer, processId);
            var sample = new ExplorerSample
            {
                ComponentsAvailable = true,
                ForegroundIsExplorer = isExplorer,
                Foreground = NativeMethods.GetForegroundWindow() == outer,
                Minimized = NativeMethods.IsIconic(outer),
                OuterHwnd = outer.ToInt64(),
                ProcessId = processId,
                ProfileAccepted = isExplorer && IsExactCandidateProfile(processId)
            };
            if (!isExplorer)
                return sample;

            sample.ActiveTabHwnd = FindActiveDirectTab(outer).ToInt64();
            ExplorerRect rect;
            if (NativeMethods.GetWindowRect(outer, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top)
            {
                sample.Rect = rect;
                sample.RectAvailable = true;
            }
            using (Process process = Process.GetProcessById((int)processId))
                sample.ProcessCreatedAt = process.StartTime.ToUniversalTime().Ticks;
            return sample;
        }

        public IList<ShellCandidate> EnumerateCandidates(long outerHwnd)
        {
            var candidates = new List<ShellCandidate>();
            try
            {
                EnsureShellWindows();
                int count = Convert.ToInt32(ReadProperty(shellWindows, "Count"));
                for (int index = 0; index < count; index++)
                {
                    object item = null;
                    object browser = null;
                    try
                    {
                        item = InvokeMethod(shellWindows, "Item", index);
                        if (item == null || Convert.ToInt64(ReadProperty(item, "HWND")) != outerHwnd)
                            continue;
                        browser = QueryShellBrowser(item);
                        IntPtr tabHwnd;
                        int result = ((IShellBrowserWindow)browser).GetWindow(out tabHwnd);
                        if (result < 0)
                            Marshal.ThrowExceptionForHR(result);
                        object captured = item;
                        item = null;
                        candidates.Add(new ShellCandidate
                        {
                            TabHwnd = tabHwnd.ToInt64(),
                            Release = delegate() { ReleaseCom(captured); }
                        });
                    }
                    finally
                    {
                        ReleaseCom(browser);
                        ReleaseCom(item);
                    }
                }
                return candidates;
            }
            catch
            {
                foreach (ShellCandidate candidate in candidates)
                    if (candidate.Release != null) candidate.Release();
                throw;
            }
        }

        public void Dispose()
        {
            ReleaseCom(shellWindows);
            shellWindows = null;
            ReleaseCom(shellApplication);
            shellApplication = null;
        }

        private static bool IsExactCandidateProfile(uint processId)
        {
            Version version = Environment.OSVersion.Version;
            using (Process process = Process.GetProcessById((int)processId))
            {
                FileVersionInfo versionInfo = FileVersionInfo.GetVersionInfo(process.MainModule.FileName);
                return ExplorerCandidateProfile.IsAcceptedReportedVersions(
                    version.Major, version.Minor, version.Build,
                    versionInfo.ProductVersion, versionInfo.FileMajorPart, versionInfo.FileMinorPart,
                    versionInfo.FileBuildPart, versionInfo.FilePrivatePart,
                    ExplorerCandidateProfile.MappingVersion);
            }
        }

        private void EnsureShellWindows()
        {
            if (shellWindows != null) return;
            try
            {
                Type shellType = Type.GetTypeFromProgID("Shell.Application", false);
                if (shellType == null)
                    throw new InvalidOperationException("SHELL_COM_UNAVAILABLE");
                shellApplication = Activator.CreateInstance(shellType);
                shellWindows = InvokeMethod(shellApplication, "Windows");
            }
            catch
            {
                ReleaseCom(shellWindows);
                shellWindows = null;
                ReleaseCom(shellApplication);
                shellApplication = null;
                throw;
            }
        }

        private static bool IsVerifiedExplorer(IntPtr hwnd, uint processId)
        {
            var className = new StringBuilder(64);
            if (NativeMethods.GetClassName(hwnd, className, className.Capacity) == 0 || className.ToString() != "CabinetWClass")
                return false;
            IntPtr process = NativeMethods.OpenProcess(0x1000, false, processId);
            if (process == IntPtr.Zero)
                return false;
            try
            {
                var path = new StringBuilder(32768);
                uint size = (uint)path.Capacity;
                if (!NativeMethods.QueryFullProcessImageName(process, 0, path, ref size))
                    return false;
                string expected = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"));
                return String.Equals(Path.GetFullPath(path.ToString()), expected, StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }

        private static IntPtr FindActiveDirectTab(IntPtr outer)
        {
            IntPtr first = IntPtr.Zero;
            IntPtr after = IntPtr.Zero;
            while (true)
            {
                IntPtr current = NativeMethods.FindWindowEx(outer, after, "ShellTabWindowClass", null);
                if (current == IntPtr.Zero)
                    return first;
                if (first == IntPtr.Zero)
                    first = current;
                after = current;
            }
        }

        private static object QueryShellBrowser(object item)
        {
            var provider = (IComServiceProvider)item;
            Guid service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
            Guid browserInterface = new Guid("000214E2-0000-0000-C000-000000000046");
            IntPtr pointer;
            int result = provider.QueryService(ref service, ref browserInterface, out pointer);
            if (result < 0)
                Marshal.ThrowExceptionForHR(result);
            if (pointer == IntPtr.Zero)
                throw new COMException("SHELL_BROWSER_UNAVAILABLE");
            try
            {
                return Marshal.GetObjectForIUnknown(pointer);
            }
            finally
            {
                Marshal.Release(pointer);
            }
        }

        private static object ReadProperty(object target, string name)
        {
            if (target == null)
                throw new COMException("SHELL_PROPERTY_UNAVAILABLE");
            return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
        }

        private static object InvokeMethod(object target, string name, object argument)
        {
            return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, new[] { argument });
        }

        private static object InvokeMethod(object target, string name)
        {
            return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, null);
        }

        private static void ReleaseCom(object value)
        {
            if (value == null || !Marshal.IsComObject(value))
                return;
            try { Marshal.FinalReleaseComObject(value); }
            catch (InvalidComObjectException) { }
        }
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IComServiceProvider
    {
        [PreserveSig]
        int QueryService(ref Guid service, ref Guid requestedInterface, out IntPtr instance);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellBrowserWindow
    {
        [PreserveSig]
        int GetWindow(out IntPtr hwnd);
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out ExplorerRect rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    }

#if SHELL_TAB_HELPER_VALIDATION
    public sealed class ShellTabCandidateValidationResult
    {
        public string Status { get; set; }
        public int MatchCount { get; set; }
        public int SwitchRound { get; set; }
        public string ErrorCode { get; set; }
    }

    /// <summary>仅专用验收编译可见；无参数且不输出窗口、路径、PID 或 COM 对象。</summary>
    public static class ShellTabCandidateValidation
    {
        private static readonly object StateGate = new object();
        private static string lastInstanceId;
        private static int switchRound;
        private static long validatedOuterHwnd;
        private static string validatedInstanceId;

        public static ShellTabCandidateValidationResult ValidateExactCandidate()
        {
            ExplorerObservationResult observed;
            try
            {
                using (var adapter = new WindowsExplorerSystemAdapter())
                    observed = ExplorerDecisionCore.Observe(adapter);
            }
            catch
            {
                observed = ExplorerDecisionCore.Result("unavailable");
            }
            lock (StateGate)
            {
                validatedOuterHwnd = observed.Status == "ready" ? observed.Hwnd : 0;
                validatedInstanceId = observed.Status == "ready" ? observed.InstanceId : null;
                if (observed.Status == "ready" &&
                    !String.Equals(lastInstanceId, observed.InstanceId, StringComparison.Ordinal))
                {
                    lastInstanceId = observed.InstanceId;
                    switchRound++;
                }
            }
            return new ShellTabCandidateValidationResult
            {
                Status = observed.Status,
                MatchCount = observed.Status == "ready" ? 1 : 0,
                SwitchRound = switchRound,
                ErrorCode = observed.Status == "ready" ? "CANDIDATE_MAPPING_VERIFIED" : "CANDIDATE_MAPPING_UNAVAILABLE"
            };
        }

        /// <summary>仅供同进程验收夹具经非公开反射读取，不进入公开 JSON 或生产编译。</summary>
        internal static long GetValidatedOuterHwnd()
        {
            lock (StateGate) return validatedOuterHwnd;
        }

        internal static string GetValidatedInstanceId()
        {
            lock (StateGate) return validatedInstanceId ?? String.Empty;
        }

    }
#endif

#if SHELL_TAB_HELPER_TEST
    internal sealed class FixedScenarioAdapter : IExplorerSystemAdapter
    {
        private readonly string scenario;
        private int sampleCount;
        private int enumerateCount;
        private int activeIndex;
        internal int TitleGetterCalls;
        internal int EnumerationCalls;
        internal int CandidateReleaseCalls;

        internal FixedScenarioAdapter(string scenario, int activeIndex)
        {
            this.scenario = scenario;
            this.activeIndex = activeIndex;
            TitleGetterCalls = 0;
        }

        public ExplorerSample Sample()
        {
            sampleCount++;
            var value = new ExplorerSample
            {
                ComponentsAvailable = true,
                ProfileAccepted = true,
                ForegroundIsExplorer = true,
                Foreground = true,
                RectAvailable = true,
                OuterHwnd = 100,
                ActiveTabHwnd = activeIndex == 0 ? 201 : 202,
                ProcessId = 300,
                ProcessCreatedAt = 400,
                Rect = new ExplorerRect { Left = 0, Top = 0, Right = 800, Bottom = 600 }
            };
            if (scenario == "not-explorer") value.ForegroundIsExplorer = false;
            if (scenario == "minimized") value.Minimized = true;
            if (scenario == "fixed-helper-file-error") value.ComponentsAvailable = false;
            if (scenario == "rect-unavailable") value.RectAvailable = false;
            if (sampleCount > 1)
            {
                if (scenario == "race-active-tab") value.ActiveTabHwnd = 202;
                if (scenario == "race-outer-hwnd") value.OuterHwnd = 101;
                if (scenario == "race-process-id") value.ProcessId = 301;
                if (scenario == "race-process-created-at") value.ProcessCreatedAt = 401;
                if (scenario == "race-foreground") value.Foreground = false;
                if (scenario == "race-rect") value.Rect.Right = 801;
                if (scenario == "race-minimized") value.Minimized = true;
            }
            return value;
        }

        public IList<ShellCandidate> EnumerateCandidates(long outerHwnd)
        {
            EnumerationCalls++;
            enumerateCount++;
            if (scenario == "com-initialization-error" || scenario == "query-service-error" || scenario == "get-window-error")
                throw new COMException("FIXED_COM_ERROR");
            var output = new List<ShellCandidate>();
            if (scenario == "zero-match")
                return output;
            if (scenario == "mapping-race" && enumerateCount > 1)
            {
                output.Add(Candidate(999));
                return output;
            }
            output.Add(Candidate(201));
            output.Add(Candidate(202));
            if (scenario == "multiple-match") output.Add(Candidate(activeIndex == 0 ? 201 : 202));
            if (scenario == "duplicate-tab-hwnd") output.Add(Candidate(201));
            return output;
        }

        private ShellCandidate Candidate(long hwnd)
        {
            return new ShellCandidate
            {
                TabHwnd = hwnd,
                Release = delegate() { CandidateReleaseCalls++; }
            };
        }

        public void Dispose() { }
    }

    public sealed class ShellTabSelfTestResult
    {
        public string scenario { get; set; }
        public string status { get; set; }
        public string[] statuses { get; set; }
        public int titleGetterCalls { get; set; }
        public int candidateEnumerationCalls { get; set; }
        public int candidateReleaseCalls { get; set; }
        public Dictionary<string, object> publicPayload { get; set; }
    }

    public static class ShellTabHelperSelfTest
    {
        public static ShellTabSelfTestResult Run(string scenario)
        {
            if (scenario == "switch-a-b-a")
            {
                string[] statuses = new string[3];
                int[] active = { 0, 1, 0 };
                for (int index = 0; index < active.Length; index++)
                {
                    using (var adapter = new FixedScenarioAdapter("normal", active[index]))
                    {
                        ExplorerObservationResult observed = ExplorerDecisionCore.Observe(adapter);
                        statuses[index] = observed.Status;
                    }
                }
                return Build(scenario, null, statuses, 0);
            }
            if (scenario == "unknown-os-major" || scenario == "unknown-os-minor" ||
                scenario == "unknown-os-build" || scenario == "unknown-product-version" ||
                scenario == "unknown-explorer-file-version" ||
                scenario == "unknown-file-major" || scenario == "unknown-file-minor" ||
                scenario == "unknown-file-build" ||
                scenario == "unknown-mapping-version" || scenario == "candidate-profile-production" ||
                scenario == "candidate-profile-validation")
            {
                bool accepted = ExplorerCandidateProfile.IsAcceptedReportedVersions(
                    scenario == "unknown-os-major" ? ExplorerCandidateProfile.OsMajor + 1 : ExplorerCandidateProfile.OsMajor,
                    scenario == "unknown-os-minor" ? ExplorerCandidateProfile.OsMinor + 1 : ExplorerCandidateProfile.OsMinor,
                    scenario == "unknown-os-build" ? ExplorerCandidateProfile.OsBuild + 1 : ExplorerCandidateProfile.OsBuild,
                    scenario == "unknown-product-version" ? "0.0.0.0" : ExplorerCandidateProfile.ExplorerProductVersion,
                    scenario == "unknown-file-major" ? 0 : ExplorerCandidateProfile.ExplorerFileMajorPart,
                    scenario == "unknown-file-minor" ? 1 : ExplorerCandidateProfile.ExplorerFileMinorPart,
                    scenario == "unknown-file-build" ? 0 : ExplorerCandidateProfile.ExplorerFileBuildPart,
                    scenario == "unknown-explorer-file-version" ? 0 : ExplorerCandidateProfile.ExplorerFilePrivatePart,
                    scenario == "unknown-mapping-version" ? "unknown" : ExplorerCandidateProfile.MappingVersion);
                return Build(scenario, accepted ? "ready" : "unavailable", null, 0);
            }
            if (!IsFixedScenario(scenario))
                throw new ArgumentException("SCENARIO_INVALID");
            int activeIndex = scenario == "active-b" ? 1 : 0;
            using (var adapter = new FixedScenarioAdapter(scenario, activeIndex))
            {
                ExplorerObservationResult observed = ExplorerDecisionCore.Observe(adapter);
                return Build(scenario, observed.Status, null, adapter.TitleGetterCalls,
                    adapter.EnumerationCalls, adapter.CandidateReleaseCalls);
            }
        }

        private static bool IsFixedScenario(string value)
        {
            string[] values = {
                "active-a", "active-b", "zero-match", "multiple-match", "duplicate-tab-hwnd",
                "race-active-tab", "race-outer-hwnd", "race-process-id", "race-process-created-at",
                "race-foreground", "race-rect", "race-minimized", "mapping-race", "rect-unavailable",
                "not-explorer", "minimized", "search-result",
                "com-initialization-error", "query-service-error", "get-window-error",
                "fixed-helper-file-error", "unknown-os-major", "unknown-os-minor", "unknown-os-build",
                "unknown-product-version", "unknown-explorer-file-version", "unknown-mapping-version",
                "candidate-profile-production", "candidate-profile-validation", "virtual-directory"
            };
            return Array.IndexOf(values, value) >= 0;
        }

        private static ShellTabSelfTestResult Build(string scenario, string status,
            string[] statuses, int titleCalls,
            int enumerationCalls = 0, int releaseCalls = 0)
        {
            return new ShellTabSelfTestResult
            {
                scenario = scenario,
                status = status,
                statuses = statuses,
                titleGetterCalls = titleCalls,
                candidateEnumerationCalls = enumerationCalls,
                candidateReleaseCalls = releaseCalls,
                publicPayload = new Dictionary<string, object> { { "status", status ?? "sequence" } }
            };
        }
    }
#endif
}
