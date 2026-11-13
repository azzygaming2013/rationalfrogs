using System.Text;

namespace WRAgent
{
    internal static class Log
    {
        private static readonly object Gate = new();
        private static string FilePath =>
            Path.Combine(PersistModule.TargetDir, "agent.log");

        public static void W(string msg)
        {
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(PersistModule.TargetDir);
                    var fi = new FileInfo(FilePath);
                    if (fi.Exists && fi.Length > 512 * 1024) fi.Delete();
                    File.AppendAllText(FilePath,
                        $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {msg}{Environment.NewLine}",
                        Encoding.UTF8);
                }
            }
            catch { /* logging must never crash the agent */ }
        }
    }
}
