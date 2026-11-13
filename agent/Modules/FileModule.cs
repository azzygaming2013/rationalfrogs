using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal static class FileModule
    {
        private static readonly Dictionary<string, FileStream> Uploads = new();
        private const int MaxList = 3000;

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
                sb.AppendLine($" {"name",-48} {"size",12}  modified");
                sb.AppendLine(new string('-', 78));

                var count = 0;
                foreach (var entry in di.EnumerateFileSystemInfos())
                {
                    if (count++ >= MaxList) break;
                    bool isDir;
                    long size = 0;
                    DateTime mtime;
                    try
                    {
                        isDir = (entry.Attributes & FileAttributes.Directory) != 0;
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
        public static async Task<JsonObject> Download(JsonObject args, Transport t)
        {
            var path = Util.Str(args, "path");
            try
            {
                if (File.Exists(path))
                {
                    var bytes = await File.ReadAllBytesAsync(path).ConfigureAwait(false);
                    var meta = new JsonObject
                    {
                        ["name"] = Path.GetFileName(path),
                        ["path"] = path
                    };
                    await t.EmitBlobAsync("file", meta, bytes).ConfigureAwait(false);
                    return new JsonObject
                    {
                        ["ok"] = true,
                        ["stdout"] = $"queued {path} ({bytes.Length} bytes)"
                    };
                }

                if (Directory.Exists(path))
                {
                    var tmp = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".zip");
                    ZipFile.CreateFromDirectory(path, tmp, CompressionLevel.Fastest, false);
                    var bytes = await File.ReadAllBytesAsync(tmp).ConfigureAwait(false);
                    try { File.Delete(tmp); } catch { }

                    var meta = new JsonObject
                    {
                        ["name"] = new DirectoryInfo(path).Name + ".zip",
                        ["path"] = path
                    };
                    await t.EmitBlobAsync("file", meta, bytes).ConfigureAwait(false);
                    return new JsonObject
                    {
                        ["ok"] = true,
                        ["stdout"] = $"queued archive of {path} ({bytes.Length} bytes)"
                    };
                }

                return new JsonObject { ["ok"] = false, ["error"] = "not found: " + path };
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
                            ["stdout"] = $"uploaded {path}"
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
