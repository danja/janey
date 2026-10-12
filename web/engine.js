// Loads janey.wasm (Janet VM + DSP core) and exposes a tiny API.
// Runs unchanged in an AudioWorklet and in Node (see test/).

function utf8Encode(str) {
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); }
    else { c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); }
    s += String.fromCodePoint(c);
  }
  return s;
}

const EBADF = 8, ENOSYS = 52;

export async function createEngine(wasmBytes, sampleRate) {
  let mem;
  let logged = [];
  const view = () => new DataView(mem.buffer);

  const wasi = {
    fd_write(fd, iovs, n, nwritten) {
      if (fd !== 1 && fd !== 2) return EBADF;
      const dv = view();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        logged.push(utf8Decode(new Uint8Array(mem.buffer, ptr, len)));
        total += len;
      }
      dv.setUint32(nwritten, total, true);
      return 0;
    },
    fd_fdstat_get(fd, buf) {
      if (fd > 2) return EBADF;
      const dv = view();
      dv.setUint8(buf, 2); // character device
      dv.setUint16(buf + 2, 0, true);
      dv.setBigUint64(buf + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    clock_time_get(id, precision, out) {
      const ms = id === 0 ? Date.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      view().setBigUint64(out, BigInt(Math.floor(ms * 1e6)), true);
      return 0;
    },
    environ_sizes_get(countPtr, sizePtr) {
      const dv = view();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get() { return 0; },
    proc_exit(code) { throw new Error('janet exited with code ' + code); },
  };

  const imports = { wasi_snapshot_preview1: new Proxy(wasi, {
    get: (t, name) => (name in t ? t[name] : () => (name === 'fd_prestat_get' ? EBADF : ENOSYS)),
  }) };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const x = instance.exports;
  mem = x.memory;
  x._initialize();
  if (x.janey_init(sampleRate) !== 0) throw new Error('janey_init failed: ' + logged.join(''));
  logged = [];

  let bufL, bufR, bufMem;
  function outViews() {
    if (bufMem !== mem.buffer) {
      bufMem = mem.buffer;
      bufL = new Float32Array(bufMem, x.janey_out_l(), 1024);
      bufR = new Float32Array(bufMem, x.janey_out_r(), 1024);
    }
  }

  return {
    // status: 'ok' (patch swapped in), 'value' (evaluated, no `play`), or 'error'
    eval(src) {
      const bytes = utf8Encode(src);
      const ptr = x.janey_alloc(bytes.length + 1);
      new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
      logged = [];
      const code = x.janey_eval(ptr, bytes.length);
      x.janey_free(ptr);
      const message = utf8Decode(new Uint8Array(mem.buffer, x.janey_result(), x.janey_result_len()));
      return { status: ['ok', 'error', 'value'][code], message, output: logged.join('') };
    },
    silence() { x.janey_silence(); },
    // Renders `frames` (<= 1024) samples; returns views valid until the next call.
    render(frames) {
      x.janey_render(frames);
      outViews();
      return [bufL.subarray(0, frames), bufR.subarray(0, frames)];
    },
    beat() { return x.janey_beat(); },
  };
}
