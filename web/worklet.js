// AudioWorklet host for the janey engine. All Janet evaluation happens here, on
// the audio thread, so a patch swap lands exactly on a render-block boundary.
import { createEngine } from './engine.js';

class JaneyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.port.onmessage = async (ev) => {
      const msg = ev.data;
      try {
        if (msg.type === 'load') {
          this.engine = await createEngine(msg.wasm, sampleRate);
          this.port.postMessage({ type: 'ready' });
        } else if (msg.type === 'eval' && this.engine) {
          this.port.postMessage({ type: 'result', id: msg.id, ...this.engine.eval(msg.code) });
        } else if (msg.type === 'silence' && this.engine) {
          this.engine.silence();
        }
      } catch (err) {
        this.port.postMessage({ type: 'fatal', message: String(err && err.message || err) });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.engine || !out.length) return true;
    const frames = out[0].length;
    const [l, r] = this.engine.render(frames);
    out[0].set(l);
    if (out[1]) out[1].set(r);
    return true;
  }
}

registerProcessor('janey', JaneyProcessor);
