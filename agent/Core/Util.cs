using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class Util
    {
        // ---- json helpers -------------------------------------------------
        public static string Str(JsonObject o, string k, string d = "")
        {
            if (o is null || !o.TryGetPropertyValue(k, out var v) || v is null) return d;
            if (v is JsonValue jv)
            {
                if (jv.TryGetValue<string>(out var s)) return s ?? d;
                return jv.ToJsonString().Trim('"');
            }
            return v.ToJsonString();
        }

        public static int Int(JsonObject o, string k, int d = 0)
        {
            if (o is null || !o.TryGetPropertyValue(k, out var v) || v is null) return d;
            if (v is JsonValue jv)
            {
                if (jv.TryGetValue<int>(out var i)) return i;
                if (jv.TryGetValue<long>(out var l)) return (int)l;
                if (jv.TryGetValue<string>(out var s) && int.TryParse(s, out var p)) return p;
            }
            return d;
        }

        public static bool Bool(JsonObject o, string k, bool d = false)
        {
            if (o is null || !o.TryGetPropertyValue(k, out var v) || v is null) return d;
            if (v is JsonValue jv)
            {
                if (jv.TryGetValue<bool>(out var b)) return b;
                if (jv.TryGetValue<string>(out var s) && bool.TryParse(s, out var p)) return p;
                if (jv.TryGetValue<int>(out var i)) return i != 0;
            }
            return d;
        }

        // ---- identity -----------------------------------------------------
        public static string MachineId()
        {
            var raw = Environment.MachineName + "|" + Environment.UserName + "|" +
                      (Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "") + "|" +
                      (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "");
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
            return Convert.ToHexString(hash, 0, 8).ToLowerInvariant();
        }

        public static string B64(byte[] data) => Convert.ToBase64String(data);

        public static string Now() => DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
    }
}
