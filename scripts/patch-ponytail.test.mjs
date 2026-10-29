import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { patchPonytail } from './patch-ponytail.mjs'

const patch = JSON.parse(await readFile(new URL('./patches/ponytail-5.3.2-rpc-status.json', import.meta.url), 'utf8'))
test('patch is guarded by version and reviewed source and is idempotent', () => {
  assert.equal(patchPonytail(patch.before, patch.version), patch.after)
  assert.equal(patchPonytail(patch.after, patch.version), patch.after)
  assert.throws(() => patchPonytail(patch.before, '6.0.0'), /requires/)
  assert.throws(() => patchPonytail('changed upstream source', patch.version), /differs/)
})

// Exercise the exact replacement against RPC's throwing theme getter.
const sync = new Function('c', 'currentMode', 'isActive', patch.after)
test('off clears without touching theme and enabled modes work without a theme', () => {
  const statuses = []
  let reads = 0
  const c = { ui: { setStatus: (...value) => statuses.push(value), get theme() { reads++; throw new Error('Theme not initialized') } } }
  sync(c, 'off', false)
  assert.deepEqual(statuses.pop(), ['ponytail', undefined])
  assert.equal(reads, 0)
  for (const mode of ['lite', 'full', 'ultra']) {
    sync(c, mode, false)
    assert.match(statuses.pop()[1], new RegExp(`○.*${mode.toUpperCase()}`))
  }
  sync(c, 'full', true)
  assert.match(statuses.pop()[1], /●.*FULL/)
})
test('interactive status retains theme formatting', () => {
  let status
  sync({ ui: { theme: { fg: (color, text) => `<${color}>${text}` }, setStatus: (_key, text) => { status = text } } }, 'full', true)
  assert.match(status, /<accent>●.*<text>⚡ FULL/)
})
