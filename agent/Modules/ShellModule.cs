using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class ShellModule
    {
        private static Encoding Oem
        {
            get
            {
                try { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
                catch { return Encoding.UTF8; }
            }
        }

        public static async Task<JsonObject> Run(JsonObject args)
        {
            var cmd = Util.Str(args, "cmd");
            var shell = Util.Str(args, "shell", "cmd").ToLowerInvariant();
            var timeout = Util.Int(args, "timeout", 60000);
            if (timeout < 1000) timeout = 60000;

            if (cmd.Length == 0)
                return new JsonObject { ["ok"] = false, ["error"] = "empty command" };

            var psi = new ProcessStartInfo
            {
                FileName = shell == "powershell" ? "powershell.exe" : "cmd.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                StandardOutputEncoding = Oem,
                StandardErrorEncoding = Oem
            };

            if (shell == "powershell")
            {
                psi.ArgumentList.Add("-NoProfile");
                psi.ArgumentList.Add("-NonInteractive");
                psi.ArgumentList.Add("-ExecutionPolicy");
                psi.ArgumentList.Add("Bypass");
                psi.ArgumentList.Add("-Command");
                psi.ArgumentList.Add(cmd);
            }
            else
            {
                psi.ArgumentList.Add("/d");
                psi.ArgumentList.Add("/s");
                psi.ArgumentList.Add("/c");
                psi.ArgumentList.Add(cmd);
            }

            using var p = new Process { StartInfo = psi };
            try
            {
                p.Start();
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }

            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();
            var exitTask = p.WaitForExitAsync();

            var finished = await Task.WhenAny(exitTask, Task.Delay(timeout)).ConfigureAwait(false);
            var timedOut = finished != exitTask;

            if (timedOut)
            {
                try { p.Kill(true); } catch { }
            }

            string stdout = "", stderr = "";
            try { stdout = await outTask.ConfigureAwait(false); } catch { }
            try { stderr = await errTask.ConfigureAwait(false); } catch { }

            var body = new JsonObject
            {
                ["ok"] = !timedOut && p.HasExited && p.ExitCode == 0,
                ["stdout"] = stdout.TrimEnd(),
                ["stderr"] = stderr.TrimEnd()
            };
            if (timedOut) body["error"] = "timeout after " + timeout + "ms";
            else
            {
                try { body["meta"] = new JsonObject { ["exit"] = p.ExitCode }; } catch { }
            }
            return body;
        }

        public static JsonObject Exec(JsonObject args)
        {
            var path = Util.Str(args, "path");
            var argv = Util.Str(args, "args");
            if (path.Length == 0)
                return new JsonObject { ["ok"] = false, ["error"] = "path required" };

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = path,
                    Arguments = argv,
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(path) is { Length: > 0 } d
                        ? d
                        : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                };
                var p = Process.Start(psi);
                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = $"started {path} pid={p?.Id}",
                    ["meta"] = new JsonObject { ["pid"] = p?.Id ?? 0 }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }
    }
}
