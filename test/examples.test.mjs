import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngine } from '../web/engine.js';
import { examples } from '../web/examples.js';

const SR = 48000;
const wasm = await readFile(new URL('../web/janey.wasm', import.meta.url));

for (const [name, code] of Object.entries(examples)) {
  test(`example "${name}" evaluates and renders audible, finite audio`, async () => {
    const e = await createEngine(wasm, SR);
    const r = e.eval(code);
    assert.equal(r.status, 'ok', r.message);
    let energy = 0;
    for (let i = 0; i < 4 * SR; i += 128) {
      const [l, rr] = e.render(128);
      for (let j = 0; j < 128; j++) {
        assert.ok(Number.isFinite(l[j]) && Math.abs(l[j]) <= 1 && Number.isFinite(rr[j]));
        energy += l[j] * l[j];
      }
    }
    assert.ok(energy > 1, `energy ${energy}`);
  });
}

test('re-evaluating an example repeatedly does not leak or break', async () => {
  const e = await createEngine(wasm, SR);
  for (let i = 0; i < 200; i++) {
    assert.equal(e.eval(examples['techno']).status, 'ok');
    e.render(128);
  }
});
