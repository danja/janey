import { examples } from './examples.js';

const $ = (id) => document.getElementById(id);
const codeEl = $('code'), logEl = $('log'), startBtn = $('start'), runBtn = $('run'), stopBtn = $('stop');
const select = $('examples');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

for (const name of Object.keys(examples)) select.add(new Option(name, name));
select.add(new Option('— examples —', ''), 0);
select.value = '';
codeEl.value = store.get('janey.code') || examples['techno'];
codeEl.addEventListener('input', () => store.set('janey.code', codeEl.value));
select.addEventListener('change', () => {
  if (!select.value) return;
  codeEl.value = examples[select.value];
  store.set('janey.code', codeEl.value);
  select.value = '';
});

function log(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

let ctx, node, nextId = 1;

async function start() {
  startBtn.disabled = true;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklet.js');
    const wasm = await (await fetch('janey.wasm')).arrayBuffer();
    const wasmKiB = Math.round(wasm.byteLength / 1024); // the buffer is detached once transferred
    node = new AudioWorkletNode(ctx, 'janey', { numberOfInputs: 0, outputChannelCount: [2] });
    const analyser = new AnalyserNode(ctx, { fftSize: 2048 });
    node.connect(analyser).connect(ctx.destination);
    node.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') {
        log('janet ready (' + wasmKiB + ' KiB wasm, ' + ctx.sampleRate + ' Hz)', 'ok');
        runBtn.disabled = stopBtn.disabled = false;
        run();
      } else if (m.type === 'result') {
        // Janet also prints errors to stderr; don't show the same text twice.
        if (m.output && !(m.status === 'error' && m.output.includes(m.message))) log(m.output.replace(/\n$/, ''));
        if (m.status === 'ok') log('✓ patch live', 'ok');
        else if (m.status === 'value') log('=> ' + m.message);
        else log(m.message, 'err');
      } else if (m.type === 'fatal') log('engine error: ' + m.message, 'err');
    };
    node.port.postMessage({ type: 'load', wasm }, [wasm]);
    drawScope(analyser);
    startBtn.textContent = 'Running';
  } catch (err) {
    log('could not start audio: ' + err.message, 'err');
    startBtn.disabled = false;
  }
}

function run() {
  if (!node) return;
  node.port.postMessage({ type: 'eval', id: nextId++, code: codeEl.value });
  codeEl.classList.remove('flash');
  void codeEl.offsetWidth;
  codeEl.classList.add('flash');
}

function silence() { if (node) node.port.postMessage({ type: 'silence' }); }

function drawScope(analyser) {
  const cv = $('scope'), g = cv.getContext('2d');
  const buf = new Float32Array(analyser.fftSize);
  (function frame() {
    analyser.getFloatTimeDomainData(buf);
    g.clearRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#7cf0b5';
    g.lineWidth = 1.5;
    g.beginPath();
    // trigger on a rising zero crossing so periodic waves hold still
    let s = 0;
    while (s < buf.length / 2 && !(buf[s] < 0 && buf[s + 1] >= 0)) s++;
    const n = buf.length / 2;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * cv.width, y = cv.height / 2 - buf[s + i] * cv.height * 0.45;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(frame);
  })();
}

startBtn.addEventListener('click', start);
runBtn.addEventListener('click', run);
stopBtn.addEventListener('click', silence);
codeEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); node ? run() : start(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); silence(); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = codeEl;
    codeEl.setRangeText('  ', a, b, 'end');
  }
});
