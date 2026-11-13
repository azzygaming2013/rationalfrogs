using System.Diagnostics;
using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WRAgent
{
    /// <summary>Second tier modules: clipboard, audio, power, registry, services, wifiâ€¦</summary>
    internal static class SysExtraModule
    {
        [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] private static extern bool LockWorkStation();

        private const byte VK_VOL_UP = 0xAF;
        private const byte VK_VOL_DOWN = 0xAE;
        private const byte VK_VOL_MUTE = 0xAD;

        private static T Sta<T>(Func<T> fn)
        {
            T result = default;
            Exception err = null;
            var t = new Thread(() =>
            {
                try { result = fn(); }
                catch (Exception e) { err = e; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            t.Join(5000);
            if (err != null) throw err;
            return result;
        }

        // ------------------------------------------------------------------
        public static JsonObject Run(string module, JsonObject args)
        {
            try
            {
                return module switch
                {
                    "clipboard" => ClipboardOp(args),
                    "msgbox" => MsgBox(args),
                    "say" => Say(args),
                    "volume" => Volume(args),
                    "power" => Power(args),
                    "services" => Services(args),
                    "registry" => RegistryOp(args),
                    "wifi" => Wifi(args),
                    "software" => Software(),
                    "tasks" => Tasks(),
                    "startup" => Startup(),
                    "search" => Search(args),
                    "kill" => Kill(args),
                    "net" => Net(),
                    _ => new JsonObject { ["ok"] = false, ["error"] = "unknown module" }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // ------------------------------------------------------------------
        private static JsonObject ClipboardOp(JsonObject args)
        {
            var action = Util.Str(args, "action", "get").ToLowerInvariant();
            if (action == "set")
            {
                var text = Util.Str(args, "text");
                Sta(() => { Clipboard.SetText(text); return true; });
                return new JsonObject { ["ok"] = true, ["stdout"] = $"clipboard set ({text.Length} chars)" };
            }

            var content = Sta(() => Clipboard.ContainsText() ? Clipboard.GetText() : "");
            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = content,
                ["meta"] = new JsonObject { ["chars"] = content.Length }
            };
        }

        private static JsonObject MsgBox(JsonObject args)
        {
            var text = Util.Str(args, "text", "hello");
            var title = Util.Str(args, "title", "Windows");
            Sta(() =>
            {
                MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return true;
            });
            return new JsonObject { ["ok"] = true, ["stdout"] = "message dismissed" };
        }

        private static JsonObject Say(JsonObject args)
        {
            var text = Util.Str(args, "text");
            if (text.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "no text" };

            Task.Run(() =>
            {
                try
                {
                    var t = Type.GetTypeFromProgID("SAPI.SpVoice");
                    if (t is null) return;
                    dynamic voice = Activator.CreateInstance(t);
                    voice.Speak(text);
                }
                catch (Exception e) { Log.W("tts: " + e.Message); }
            });

            return new JsonObject { ["ok"] = true, ["stdout"] = "speaking" };
        }

        private static JsonObject Volume(JsonObject args)
        {
            var action = Util.Str(args, "action", "up").ToLowerInvariant();
            var steps = Math.Clamp(Util.Int(args, "steps", 5), 1, 50);

            if (action == "mute")
            {
                keybd_event(VK_VOL_MUTE, 0, 0, UIntPtr.Zero);
                return new JsonObject { ["ok"] = true, ["stdout"] = "toggled mute" };
            }

            var key = action == "down" ? VK_VOL_DOWN : VK_VOL_UP;
            for (var i = 0; i < steps; i++)
            {
                keybd_event(key, 0, 0, UIntPtr.Zero);
                keybd_event(key, 0, 2, UIntPtr.Zero);
                Thread.Sleep(15);
            }
            return new JsonObject { ["ok"] = true, ["stdout"] = $"volume {action} x{steps}" };
        }

        private static JsonObject Power(JsonObject args)
        {
            var action = Util.Str(args, "action", "lock").ToLowerInvariant();
            switch (action)
            {
                case "lock":
                    LockWorkStation();
                    return new JsonObject { ["ok"] = true, ["stdout"] = "locked" };
                case "logoff":
                    Process.Start("shutdown.exe", "/l /f");
                    return new JsonObject { ["ok"] = true, ["stdout"] = "logging off" };
                case "reboot":
                    Process.Start("shutdown.exe", "/r /t 0 /f");
                    return new JsonObject { ["ok"] = true, ["stdout"] = "rebooting" };
                case "shutdown":
                    Process.Start("shutdown.exe", "/s /t 0 /f");
                    return new JsonObject { ["ok"] = true, ["stdout"] = "shutting down" };
                case "sleep":
                    Process.Start("rundll32.exe", "powrprof.dll,SetSuspendState 0,1,0");
                    return new JsonObject { ["ok"] = true, ["stdout"] = "sleeping" };
                default:
                    return new JsonObject { ["ok"] = false, ["error"] = "unknown action" };
            }
        }

        private static JsonObject Services(JsonObject args)
        {
            var action = Util.Str(args, "action", "list").ToLowerInvariant();

            if (action == "list")
            {
                var arr = new JsonArray();
                var sb = new StringBuilder();
                sb.AppendLine($" {"state",-10} {"start",-10} name");
                sb.AppendLine(new string('-', 70));

                using var searcher = new ManagementObjectSearcher(
                    "SELECT Name, DisplayName, State, StartMode FROM Win32_Service");
                foreach (ManagementObject mo in searcher.Get())
                {
                    var row = new JsonObject
                    {
                        ["name"] = mo["Name"]?.ToString(),
                        ["display"] = mo["DisplayName"]?.ToString(),
                        ["state"] = mo["State"]?.ToString(),
                        ["start"] = mo["StartMode"]?.ToString()
                    };
                    arr.Add(row);
                    sb.AppendLine($" {row["state"],-10} {row["start"],-10} {row["name"]} â€” {row["display"]}");
                }

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = sb.ToString().TrimEnd(),
                    ["meta"] = new JsonObject { ["services"] = arr }
                };
            }

            var name = Util.Str(args, "name");
            if (name.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "name required" };

            using var svc = new ManagementObjectSearcher(
                $"SELECT * FROM Win32_Service WHERE Name='{name.Replace("'", "''")}'");
            foreach (ManagementObject mo in svc.Get())
            {
                var raw = mo.InvokeMethod(action == "stop" ? "StopService" : "StartService", null, null);
                var code = raw is null ? -1 : Convert.ToInt32(raw["ReturnValue"] ?? -1);
                return new JsonObject
                {
                    ["ok"] = code == 0,
                    ["stdout"] = $"{action} {name} -> {code}"
                };
            }
            return new JsonObject { ["ok"] = false, ["error"] = "service not found" };
        }

        private static JsonObject RegistryOp(JsonObject args)
        {
            var action = Util.Str(args, "action", "get").ToLowerInvariant();
            var keyPath = Util.Str(args, "key");
            if (keyPath.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "key required" };

            var (hive, sub) = SplitKey(keyPath);

            if (action == "get")
            {
                using var key = hive.OpenSubKey(sub);
                if (key is null) return new JsonObject { ["ok"] = false, ["error"] = "key not found" };

                var name = Util.Str(args, "name");
                var sb = new StringBuilder();
                var meta = new JsonObject();

                if (name.Length == 0)
                {
                    foreach (var n in key.GetValueNames())
                        sb.AppendLine($"{n,-40} {(key.GetValue(n) is byte[] b ? $"<{b.Length} bytes>" : key.GetValue(n))}");
                    foreach (var n in key.GetSubKeyNames())
                        sb.AppendLine($"[{n}]");
                }
                else
                {
                    var v = key.GetValue(name);
                    sb.AppendLine(v is byte[] bytes ? Convert.ToHexString(bytes) : v?.ToString() ?? "");
                    meta["value"] = v?.ToString();
                }

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = sb.ToString().TrimEnd(),
                    ["meta"] = meta
                };
            }

            if (action == "set")
            {
                using var key = hive.CreateSubKey(sub);
                key?.SetValue(Util.Str(args, "name"), Util.Str(args, "value"));
                return new JsonObject { ["ok"] = true, ["stdout"] = "written" };
            }

            if (action == "del")
            {
                using var key = hive.OpenSubKey(sub, writable: true);
                key?.DeleteValue(Util.Str(args, "name"), throwOnMissingValue: false);
                return new JsonObject { ["ok"] = true, ["stdout"] = "value deleted" };
            }

            return new JsonObject { ["ok"] = false, ["error"] = "unknown action" };
        }

        private static (RegistryKey, string) SplitKey(string path)
        {
            var idx = path.IndexOf('\\');
            var root = idx < 0 ? path : path.Substring(0, idx);
            var sub = idx < 0 ? "" : path.Substring(idx + 1);
            RegistryKey hive = root.ToUpperInvariant() switch
            {
                "HKCU" or "HKEY_CURRENT_USER" => Registry.CurrentUser,
                "HKLM" or "HKEY_LOCAL_MACHINE" => Registry.LocalMachine,
                "HKCR" or "HKEY_CLASSES_ROOT" => Registry.ClassesRoot,
                "HKU" or "HKEY_USERS" => Registry.Users,
                _ => Registry.CurrentUser
            };
            return (hive, sub);
        }

        private static JsonObject Wifi(JsonObject args)
        {
            var action = Util.Str(args, "action", "profiles").ToLowerInvariant();

            if (action == "password")
            {
                var name = Util.Str(args, "name");
                var (outText, _) = Exec("netsh.exe", $"wlan show profile name=\"{name}\" key=clear");
                var key = outText.Split('\n')
                    .FirstOrDefault(l => l.Contains("Key Content"))?
                    .Split(':') is { Length: > 1 } parts ? parts[1].Trim() : null;
                return new JsonObject
                {
                    ["ok"] = key != null,
                    ["stdout"] = key ?? outText,
                    ["meta"] = new JsonObject { ["ssid"] = name, ["password"] = key ?? "" }
                };
            }

            var (list, _) = Exec("netsh.exe", "wlan show profiles");
            var names = new JsonArray();
            var sb = new StringBuilder();
            foreach (var line in list.Split('\n'))
            {
                var idx = line.IndexOf(": ");
                if (!line.Contains("All User Profile")) continue;
                if (idx < 0) continue;
                var ssid = line.Substring(idx + 2).Trim();
                names.Add(ssid);
                sb.AppendLine(ssid);
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["profiles"] = names }
            };
        }

        private static JsonObject Software()
        {
            var arr = new JsonArray();
            var sb = new StringBuilder();
            var roots = new[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };

            foreach (var root in roots)
            {
                using var key = Registry.LocalMachine.OpenSubKey(root);
                if (key is null) continue;
                foreach (var sub in key.GetSubKeyNames())
                {
                    try
                    {
                        using var app = key.OpenSubKey(sub);
                        var name = app?.GetValue("DisplayName")?.ToString();
                        if (string.IsNullOrWhiteSpace(name)) continue;
                        var row = new JsonObject
                        {
                            ["name"] = name,
                            ["version"] = app.GetValue("DisplayVersion")?.ToString() ?? "",
                            ["publisher"] = app.GetValue("Publisher")?.ToString() ?? "",
                            ["date"] = app.GetValue("InstallDate")?.ToString() ?? ""
                        };
                        arr.Add(row);
                        sb.AppendLine($"{name}\t{row["version"]}\t{row["publisher"]}");
                    }
                    catch { }
                }
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["apps"] = arr }
            };
        }

        private static JsonObject Tasks()
        {
            var (outText, _) = Exec("schtasks.exe", "/query /fo csv /nh");
            var arr = new JsonArray();
            var sb = new StringBuilder();
            foreach (var line in outText.Split('\n'))
            {
                var t = line.Trim();
                if (t.Length == 0) continue;
                var cols = t.Split("\",\"");
                if (cols.Length < 2) continue;
                var name = cols[0].Trim('"');
                if (name.Length == 0) continue;
                arr.Add(new JsonObject { ["name"] = name, ["status"] = cols.Length > 2 ? cols[2].Trim('"') : "" });
                sb.AppendLine(name);
            }
            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["tasks"] = arr }
            };
        }

        private static JsonObject Startup()
        {
            var sb = new StringBuilder();
            var arr = new JsonArray();

            void Read(RegistryKey hive, string path, string label)
            {
                try
                {
                    using var key = hive.OpenSubKey(path);
                    if (key is null) return;
                    foreach (var name in key.GetValueNames())
                    {
                        var value = key.GetValue(name)?.ToString() ?? "";
                        arr.Add(new JsonObject { ["hive"] = label, ["name"] = name, ["cmd"] = value });
                        sb.AppendLine($"[{label}] {name} = {value}");
                    }
                }
                catch { }
            }

            Read(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Run", "HKCU");
            Read(Registry.LocalMachine, @"Software\Microsoft\Windows\CurrentVersion\Run", "HKLM");
            Read(Registry.LocalMachine, @"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run", "HKLM32");

            foreach (var folder in new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.Startup),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup)
            })
            {
                try
                {
                    foreach (var f in Directory.GetFiles(folder))
                    {
                        arr.Add(new JsonObject { ["hive"] = "folder", ["name"] = Path.GetFileName(f), ["cmd"] = f });
                        sb.AppendLine($"[startup] {f}");
                    }
                }
                catch { }
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["items"] = arr }
            };
        }

        private static JsonObject Search(JsonObject args)
        {
            var root = Util.Str(args, "path", "C:\\");
            var pattern = Util.Str(args, "pattern", "*");
            var max = Math.Clamp(Util.Int(args, "max", 200), 1, 2000);

            var arr = new JsonArray();
            var sb = new StringBuilder();
            var opt = new System.IO.EnumerationOptions
            {
                IgnoreInaccessible = true,
                RecurseSubdirectories = true,
                AttributesToSkip = FileAttributes.ReparsePoint
            };

            foreach (var f in Directory.EnumerateFiles(root, pattern, opt).Take(max))
            {
                var fi = new FileInfo(f);
                arr.Add(new JsonObject
                {
                    ["name"] = fi.Name, ["path"] = fi.FullName,
                    ["size"] = fi.Length, ["mtime"] = fi.LastWriteTimeUtc.ToString("o")
                });
                sb.AppendLine($"{fi.Length,12}  {fi.FullName}");
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.Length == 0 ? "no matches" : sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["results"] = arr, ["root"] = root, ["pattern"] = pattern }
            };
        }

        private static JsonObject Kill(JsonObject args)
        {
            var pid = Util.Int(args, "pid", 0);
            var name = Util.Str(args, "name");

            if (pid > 0)
            {
                using var p = Process.GetProcessById(pid);
                p.Kill(true);
                return new JsonObject { ["ok"] = true, ["stdout"] = $"killed pid {pid}" };
            }

            if (name.Length > 0)
            {
                var killed = 0;
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try { p.Kill(true); killed++; } catch { }
                    finally { p.Dispose(); }
                }
                return new JsonObject { ["ok"] = killed > 0, ["stdout"] = $"killed {killed} x {name}" };
            }

            return new JsonObject { ["ok"] = false, ["error"] = "pid or name required" };
        }

        private static JsonObject Net()
        {
            var sb = new StringBuilder();
            var arr = new JsonArray();
            sb.AppendLine($" {"local",-24} {"remote",-24} state");
            sb.AppendLine(new string('-', 70));

            var props = IPGlobalProperties.GetIPGlobalProperties();
            foreach (var c in props.GetActiveTcpConnections())
            {
                var local = $"{c.LocalEndPoint.Address}:{c.LocalEndPoint.Port}";
                var remote = $"{c.RemoteEndPoint.Address}:{c.RemoteEndPoint.Port}";
                sb.AppendLine($" {local,-24} {remote,-24} {c.State}");
                arr.Add(new JsonObject { ["local"] = local, ["remote"] = remote, ["state"] = c.State.ToString() });
            }

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = sb.ToString().TrimEnd(),
                ["meta"] = new JsonObject { ["connections"] = arr }
            };
        }

        private static (string, int) Exec(string file, string args)
        {
            var psi = new ProcessStartInfo
            {
                FileName = file,
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            using var p = Process.Start(psi);
            var text = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit(10000);
            return (text, p.HasExited ? p.ExitCode : -1);
        }
    }
}

