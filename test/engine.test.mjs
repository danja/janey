import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngine } from '../web/engine.js';

const SR = 48000;
const wasm = await readFile(new URL('../web/janey.wasm', import.meta.url));

async function boot() { return createEngine(wasm, SR); }

// Render `seconds` of mono (left channel) audio in 128-frame blocks.
function render(engine, seconds) {
  const total = Math.floor(seconds * SR);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i);
    out.set(engine.render(n)[0], i);
  }
  return out;
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const tail = (a, from) => a.subarray(Math.floor(from * SR));

function freqOf(a) {
  let crossings = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) crossings++;
  return crossings / (a.length / SR);
}

test('janet evaluates plain code', async () => {
  const e = await boot();
  const r = e.eval('(+ 1 2 3)');
  assert.equal(r.status, 'value');
  assert.equal(r.message, '6');
});

test('print output is captured', async () => {
  const e = await boot();
  const r = e.eval('(print "hello from janet")');
  assert.match(r.output, /hello from janet/);
});

test('sine oscillator has the requested frequency', async () => {
  const e = await boot();
  assert.equal(e.eval('(play (* 0.5 (sine 440)))').status, 'ok');
  const a = tail(render(e, 1.0), 0.2);
  assert.ok(Math.abs(freqOf(a) - 440) < 2, `freq ${freqOf(a)}`);
  const peak = Math.max(...a);
  assert.ok(peak > 0.4 && peak < 0.5, `peak ${peak}`);
});

test('operators work with numbers on either side and variadically', async () => {
  const e = await boot();
  // 0.25 + (1 - 0.5) + 0.25*2 = 1.25 -> constant; tanh(1.25)
  assert.equal(e.eval('(play (+ 0.25 (- 1 0.5) (* 0.25 (+ 1 1))))').status, 'ok');
  // constants fold into signals; offset sine mean is the offset
  e.eval('(play (+ 0.5 (* 0.1 (sine 100))))');
  const a = tail(render(e, 0.5), 0.1);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(Math.abs(mean - Math.tanh(0.5)) < 0.02, `mean ${mean}`);
  e.eval('(play (/ 1 (+ 2 (* 0 (sine 1)))))'); // r/ : 1/2
  const b = tail(render(e, 0.2), 0.1);
  assert.ok(Math.abs(b[100] - Math.tanh(0.5)) < 1e-3);
  e.eval('(play (- 0.5 (* 0 (sine 1))))');     // r- via signal on right side
  assert.ok(Math.abs(tail(render(e, 0.2), 0.1)[100] - Math.tanh(0.5)) < 1e-3);
});

test('lowpass filter removes highs and highpass removes lows', async () => {
  const e = await boot();
  e.eval('(play (saw 4000))');
  const raw = rms(tail(render(e, 0.5), 0.2));
  e.eval('(play (lpf (saw 4000) 300))');
  const lp = rms(tail(render(e, 0.5), 0.2));
  assert.ok(lp < raw * 0.1, `lp ${lp} raw ${raw}`);
  e.eval('(play (hpf (sine 100) 5000))');
  const hp = rms(tail(render(e, 0.5), 0.2));
  assert.ok(hp < 0.01, `hp ${hp}`);
});

test('trig fires on the beat grid (120 bpm -> every 0.5s); a new patch joins mid-step', async () => {
  const e = await boot();
  e.eval('(bpm 120)(play (trig [1] 1))');
  const a = render(e, 2.0);
  const hits = [];
  for (let i = 0; i < a.length; i++) if (a[i] > 0.1) hits.push(i / SR);
  assert.equal(hits.length, 3, `hits at ${hits}`); // beat 0 itself is not re-fired on install
  assert.ok(Math.abs(hits[0] - 0.5) < 0.002);
  for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i] - hits[i - 1] - 0.5) < 0.002);
});

test('seq holds values and rests keep the previous one', async () => {
  const e = await boot();
  e.eval('(bpm 120)(play (* 0.1 (seq [1 nil 3 nil] 2)))'); // 2 steps/beat => 0.25s/step
  const a = render(e, 1.0);
  // undo the master tanh and the 0.1 scaling
  const near = (t, want) => assert.ok(Math.abs(Math.atanh(a[Math.floor(t * SR)]) / 0.1 - want) < 0.02, `t=${t} got ${Math.atanh(a[Math.floor(t * SR)]) / 0.1}`);
  near(0.1, 1); near(0.35, 1); near(0.6, 3); near(0.85, 3);
});

test('envelope decays after a trigger', async () => {
  const e = await boot();
  e.eval('(bpm 120)(play (ad (trig [nil 1 nil nil] 4) 0.001 0.1))'); // fires at 0.125s
  const a = render(e, 0.45);
  assert.ok(Math.max(...a.subarray(0.125 * SR, 0.15 * SR)) > 0.5);
  assert.ok(Math.abs(a[Math.floor(0.4 * SR)]) < 0.01);
});

test('delay repeats the signal', async () => {
  const e = await boot();
  e.eval('(bpm 120)(play (delay (ad (trig [nil 1 nil nil nil nil nil nil] 4) 0.001 0.02) 0.25 0))'); // hit at 0.125s, echo at 0.375s
  const a = render(e, 0.6);
  const early = Math.max(...a.subarray(0, 0.3 * SR));
  const echo = Math.max(...a.subarray(0.375 * SR, 0.42 * SR));
  assert.ok(early < 0.01, 'dry signal must not leak through');
  assert.ok(echo > 0.3, `echo ${echo}`);
});

test('errors leave the playing patch untouched', async () => {
  const e = await boot();
  e.eval('(play (* 0.5 (sine 440)))');
  render(e, 0.2);
  const bad = e.eval('(play (sine 440)');          // unbalanced paren
  assert.equal(bad.status, 'error');
  const bad2 = e.eval('(play (lpf 1))');            // wrong arity
  assert.equal(bad2.status, 'error');
  const bad3 = e.eval('(play (nosuchfn 1))');
  assert.equal(bad3.status, 'error');
  const a = tail(render(e, 0.5), 0.1);
  assert.ok(Math.abs(freqOf(a) - 440) < 3);
});

test('signals from an earlier evaluation are rejected', async () => {
  const e = await boot();
  e.eval('(def old (sine 220))');
  const r = e.eval('(play old)');
  assert.equal(r.status, 'error');
  assert.match(r.message, /earlier evaluation/);
});

test('hot swap crossfades without clicks', async () => {
  const e = await boot();
  e.eval('(play (* 0.5 (sine 220)))');
  render(e, 0.3);
  e.eval('(play (* 0.5 (sine 330)))');
  const a = render(e, 0.3);
  let maxStep = 0;
  for (let i = 1; i < a.length; i++) maxStep = Math.max(maxStep, Math.abs(a[i] - a[i - 1]));
  assert.ok(maxStep < 0.08, `max sample step ${maxStep}`);
});

test('silence fades out', async () => {
  const e = await boot();
  e.eval('(play (sine 220))');
  render(e, 0.2);
  e.silence();
  const a = render(e, 0.3);
  assert.ok(rms(tail(a, 0.15)) === 0);
});

test('a full patch stays finite and bounded', async () => {
  const e = await boot();
  const r = e.eval(`
    (bpm 128)
    (def kick-env (ad (trig [1 nil nil nil 1 nil nil nil] 4) 0.001 0.25))
    (def kick (* kick-env (sine (+ 45 (* 120 kick-env)))))
    (def bass (lpf (saw (mtof (seq [36 36 48 36] 4))) (rescale (sine 0.25) 200 2000) 4))
    (play (+ (* 0.8 kick) (* 0.3 bass) (delay (* 0.2 bass) (beats 0.75) 0.5)))`);
  assert.equal(r.status, 'ok', r.message);
  const a = render(e, 4);
  for (const v of a) assert.ok(Number.isFinite(v) && Math.abs(v) <= 1);
  assert.ok(rms(a) > 0.05);
});
