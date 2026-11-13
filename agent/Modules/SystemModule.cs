using System.Diagnostics;
using System.Management;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace WRAgent
{
    internal static class SystemModule
    {
        // ------------------------------------------------------------------
        public static JsonObject Identity()
        {
            var ips = new JsonArray();
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                            ips.Add(ua.Address.ToString());
                    }
                }
            }
            catch { }

            return new JsonObject
            {
                ["host"] = Environment.MachineName,
                ["user"] = Environment.UserName,
                ["domain"] = Environment.UserDomainName,
                ["os"] = OsName(),
                ["os_short"] = OsShort(),
                ["arch"] = Environment.Is64BitOperatingSystem ? "amd64" : "x86",
                ["pid"] = Environment.ProcessId,
                ["admin"] = IsAdmin(),
                ["ips"] = ips,
                ["cpu"] = CpuShort(),
                ["ram"] = TotalRam() / 1073741824.0,
                ["tag"] = BuildInfo.AgentTag
            };
        }

        public static int MonitorCount()
        {
            try { return System.Windows.Forms.Screen.AllScreens.Length; }
            catch { return 1; }
        }

        public static string GpuName()
        {
            try
            {
                using var searcher = new ManagementObjectSearcher(
                    "SELECT Name FROM Win32_VideoController");
                foreach (ManagementObject mo in searcher.Get())
                {
                    var name = mo["Name"]?.ToString();
                    if (!string.IsNullOrWhiteSpace(name) && !name.Contains("Basic Display"))
                        return name.Trim();
                }
            }
            catch { }
            return "unknown";
        }

        public static string OsShort()
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
                var build = int.TryParse(key?.GetValue("CurrentBuild")?.ToString(), out var b) ? b : 0;
                return build >= 22000 ? "W11" : "W10";
            }
            catch { return "WIN"; }
        }

        /// <summary>"Intel(R) Core(TM) i5-13400F CPU @ 2.50GHz" -> "i5-13400F"</summary>
        private static string CpuShort()
        {
            var raw = CpuName();
            var m = System.Text.RegularExpressions.Regex.Match(raw,
                @"(i[3579][- ]\d{4,5}[A-Z]{0,2}|Ryzen\s+\d\s+\d{4}[A-Z]{0,2}|Ultra\s+\d\s+\d{3}[A-Z]{0,2})");
            if (m.Success) return m.Value.Replace(" ", " ");
            return raw.Length > 26 ? raw.Substring(0, 26) : raw;
        }

        public static JsonObject Drives()
        {
            var arr = new JsonArray();
            try
            {
                foreach (var d in DriveInfo.GetDrives())
                {
                    string label = null;
                    try { label = d.VolumeLabel; } catch { }
                    arr.Add(new JsonObject
                    {
                        ["name"] = d.Name,
                        ["type"] = d.DriveType.ToString(),
                        ["label"] = label ?? "",
                        ["format"] = d.IsReady ? d.DriveFormat : "",
                        ["total"] = d.IsReady ? d.TotalSize : 0,
                        ["free"] = d.IsReady ? d.AvailableFreeSpace : 0
                    });
                }
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = string.Join("\n", arr.Select(a => $"{a["name"],-4} {a["type"],-8} {a["label"]}")),
                ["meta"] = new JsonObject { ["drives"] = arr }
            };
        }

        // ------------------------------------------------------------------
        public static JsonObject Info()
        {
            var id = Identity();
            var lines = new StringBuilder();
            lines.AppendLine($"host      {id["host"]}");
            lines.AppendLine($"user      {id["user"]}\\{Environment.UserName}");
            lines.AppendLine($"os        {id["os"]}");
            lines.AppendLine($"arch      {id["arch"]} ({(Environment.Is64BitProcess ? "64" : "32")}-bit process)");
            lines.AppendLine($"pid       {id["pid"]}");
            lines.AppendLine($"admin     {(IsAdmin() ? "yes" : "no")}");
            lines.AppendLine($"cwd       {Environment.CurrentDirectory}");
            lines.AppendLine($"boot      {BootTime():yyyy-MM-dd HH:mm:ss}");
            lines.AppendLine($"uptime    {Uptime()}");
            lines.AppendLine($"cpu       {CpuName()}");
            lines.AppendLine($"cores     {Environment.ProcessorCount}");
            lines.AppendLine($"ram       {RamText()}");
            lines.AppendLine($"ips       {string.Join(", ", id["ips"].AsArray().Select(x => x.ToString()))}");

            var av = new JsonArray();
            try
            {
                using var searcher = new ManagementObjectSearcher(
                    @"root\SecurityCenter2", "SELECT displayName FROM AntiVirusProduct");
                foreach (ManagementObject mo in searcher.Get())
                {
                    var name = mo["displayName"]?.ToString();
                    if (!string.IsNullOrWhiteSpace(name)) av.Add(name);
                }
            }
            catch { }
            lines.AppendLine($"av        {(av.Count == 0 ? "none detected" : string.Join(", ", av.Select(x => x.ToString())))}");

            var drives = new JsonArray();
            try
            {
                foreach (var d in DriveInfo.GetDrives())
                {
                    if (!d.IsReady) continue;
                    drives.Add(new JsonObject
                    {
                        ["name"] = d.Name,
                        ["type"] = d.DriveType.ToString(),
                        ["format"] = d.DriveFormat,
                        ["total"] = d.TotalSize,
                        ["free"] = d.AvailableFreeSpace
                    });
                    lines.AppendLine($"drive     {d.Name,-4} {d.DriveType,-8} {Gb(d.AvailableFreeSpace)} free / {Gb(d.TotalSize)}");
                }
            }
            catch { }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = lines.ToString().TrimEnd(),
                ["meta"] = new JsonObject
                {
                    ["identity"] = id.DeepClone(),
                    ["av"] = av,
                    ["drives"] = drives,
                    ["cpu"] = CpuName(),
                    ["ram_bytes"] = TotalRam(),
                    ["uptime_sec"] = Environment.TickCount64 / 1000
                }
            };
        }

        // ------------------------------------------------------------------
        public static JsonObject Processes()
        {
            var arr = new JsonArray();
            var sb = new StringBuilder();
            sb.AppendLine($" {"pid",7}  {"ws",10}  {"name",-28}  path");
            sb.AppendLine(new string('-', 80));

            var list = new List<(int pid, long ws, string name, string path)>();
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    var path = "";
                    try { path = p.MainModule?.FileName ?? ""; } catch { }
                    list.Add((p.Id, p.WorkingSet64, p.ProcessName, path));
                }
                catch { }
                finally { p.Dispose(); }
            }

            foreach (var p in list.OrderByDescending(x => x.ws).Take(400))
            {
                arr.Add(new JsonObject
                {
                    ["pid"] = p.pid, ["name"] = p.name,
                    ["ws"] = p.ws, ["path"] = p.path
                });
                sb.AppendLine($" {p.pid,7}  {Mb(p.ws),10}  {p.name,-28}  {p.path}");
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["processes"] = arr }
            };
        }

        // ------------------------------------------------------------------
        public static bool IsAdmin()
        {
            try
            {
                using var id = WindowsIdentity.GetCurrent();
                var principal = new WindowsPrincipal(id);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        public static string OsName()
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
                var name = key?.GetValue("ProductName")?.ToString() ?? "Windows";
                var build = key?.GetValue("CurrentBuild")?.ToString() ?? "";
                var disp = key?.GetValue("DisplayVersion")?.ToString() ?? "";
                if (name.Contains("Windows 10") && int.TryParse(build, out var b) && b >= 22000)
                    name = name.Replace("Windows 10", "Windows 11");
                return $"{name} {disp} (build {build})".Trim();
            }
            catch
            {
                return Environment.OSVersion.ToString();
            }
        }

        private static DateTime BootTime()
        {
            try { return DateTime.Now - TimeSpan.FromMilliseconds(Environment.TickCount64); }
            catch { return DateTime.Now; }
        }

        private static string Uptime()
        {
            var t = TimeSpan.FromMilliseconds(Environment.TickCount64);
            return $"{(int)t.TotalDays}d {t.Hours}h {t.Minutes}m";
        }

        private static string CpuName()
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(
                    @"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
                return key?.GetValue("ProcessorNameString")?.ToString()?.Trim() ?? "unknown";
            }
            catch { return "unknown"; }
        }

        private static long TotalRam()
        {
            try
            {
                using var searcher = new ManagementObjectSearcher(
                    "SELECT TotalPhysicalMemory FROM Win32_ComputerSystem");
                foreach (ManagementObject mo in searcher.Get())
                    return long.Parse(mo["TotalPhysicalMemory"]?.ToString() ?? "0");
            }
            catch { }
            return 0;
        }

        private static string RamText()
        {
            var total = TotalRam();
            return total == 0 ? "unknown" : Gb(total) + " total";
        }

        private static string Gb(long bytes) => (bytes / 1073741824.0).ToString("0.0") + " GB";
        private static string Mb(long bytes) => (bytes / 1048576.0).ToString("0.0") + " MB";
    }
}
