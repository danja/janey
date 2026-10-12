# janey

Livecoding music in [Janet](https://janet-lang.org/), running in the browser as WebAssembly, with a small DSP core written in C.

Yes, Janet works from wasm. `build.sh` compiles Janet's amalgamated source plus `src/dsp.c` to a standalone WASI module (`web/janey.wasm`, ~840 KiB) using [wasi-sdk](https://github.com/WebAssembly/wasi-sdk). No Emscripten is needed. The module runs inside an `AudioWorklet`.

```
./build.sh          # first time only; produces web/janey.wasm
npm run serve        # then open http://localhost:8080
```

Click **Start audio**, edit, and press **Ctrl+Enter** to hot-swap the patch. **Ctrl+.** silences. `web/janey.wasm` is not committed. Run `./build.sh` once first (see Building below).

## How it works

Janet is only used to *describe* the sound. Each call such as `(sine 220)` adds a node to a unit-generator graph and returns a signal handle. `+ - * /` work on handles too, so patches are plain Janet. The audio callback renders the graph in C, per sample, and never re-enters the Janet VM.

Each successful `(play ...)` builds a fresh graph and crossfades (40 ms) from the old one. A patch with an error is rejected and the previous one keeps playing. Sequencers read a global beat clock, so timing survives reloads, and a new patch joins mid-step instead of re-triggering the current one.

```janet
(bpm 126)
(def env  (ad (trig [1 nil nil nil 1 nil nil nil] 4) 0.001 0.3))   # 4 steps per beat
(def kick (* env (sine (+ 42 (* 140 env)))))                        # pitch sweep
(def bass (lpf (saw (mtof (seq [36 36 48 39] 2))) (rescale (sine 0.1) 300 2000) 4))
(play (+ (* 0.9 kick) (* 0.3 bass)))
```

## DSP reference

| Function | |
|---|---|
| `(sine f)` `(saw f)` `(square f)` `(tri f)` | oscillators (saw/square are polyBLEP band-limited) |
| `(noise)` | white noise |
| `(lpf sig cutoff &opt q)` `(hpf …)` `(bpf …)` | resonant state-variable filters |
| `(drive sig amount)` | tanh waveshaper |
| `(delay sig seconds &opt feedback)` | feedback delay, wet output only, up to 4 s |
| `(seq steps rate)` | holds the current step's value; `nil` rests; `rate` = steps per beat |
| `(trig steps rate)` | one-sample pulse at each active step (`1`/`true` hit, `0`/`nil` rest) |
| `(ad trig &opt attack decay)` | attack/decay envelope fired by a trigger |
| `(mtof note)` | MIDI note to Hz, on numbers or signals |
| `(play left &opt right)` | set the output (mono or stereo) |
| `(bpm &opt n)` `(beats n)` | tempo, and seconds in `n` beats |
| `(rescale sig lo hi)` `(mix a b …)` | helpers, written in Janet in the prelude |

Any argument that takes a signal also takes a plain number. The master output goes through `tanh`.

Notes and limits:

- **Define signals with `defn`, or inside the same evaluation.** A signal belongs to the evaluation that built it, and using one in a later eval gives a clear error. Plain Janet values and functions persist between evals as usual.
- Evaluation runs on the audio thread. Small patches are instant, but a very heavy eval can glitch.
- Up to 512 nodes per patch, 64 steps per pattern.
- Janet's OS, networking, threads and FFI are compiled out, since they make no sense in a browser.

## Building

Needs `git`, `make`, a C compiler, `curl` and `tar`. `build.sh` downloads Janet and wasi-sdk 25 into `build/`.

```
./build.sh       # -> web/janey.wasm
npm test         # Node renders patches through the wasm and checks the audio
```

wasi-sdk 25 or newer is required, because Janet's error handling uses `setjmp`/`longjmp` and older SDKs lower it to Emscripten-only helpers. The module uses WebAssembly exception handling, which Chrome, Firefox and Safari all support.

## Hosting on GitHub Pages

`.github/workflows/pages.yml` builds the wasm, runs the tests, and deploys `web/` to GitHub Pages on every push to `main`. In the repository settings, set Pages → Source to "GitHub Actions" if the workflow's automatic enablement doesn't take. The site is fully static, and all URLs are relative, so it works under `/janey/`.

Janet is MIT licensed, and so is this project.
