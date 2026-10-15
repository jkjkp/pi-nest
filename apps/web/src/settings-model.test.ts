import { expect, it } from 'vitest'
import { changedSettings, jsonDraftChanged, secondsToMilliseconds, settingsEqual } from './settings-model.js'

it('converts seconds to exact integer milliseconds without rounding away existing precision', () => {
  expect(secondsToMilliseconds('300')).toBe(300000)
  expect(secondsToMilliseconds('300.000')).toBe(300000)
  expect(secondsToMilliseconds('300.001')).toBe(300001)
  expect(secondsToMilliseconds('0.001')).toBe(1)
  expect(secondsToMilliseconds('3600')).toBe(3600000)
  for (const text of ['', ' ', '-', '-1', '1.', '1.0001', '3600.001', 'Infinity', '1e2', '1,5']) expect(secondsToMilliseconds(text)).toBeUndefined()
})

it('clears changes when a numeric draft returns to its saved value', () => {
  const before = { httpIdleTimeoutMs: 300000 }
  expect(changedSettings(before, { httpIdleTimeoutMs: secondsToMilliseconds('301')! })).toEqual({ httpIdleTimeoutMs: 301000 })
  expect(changedSettings(before, { httpIdleTimeoutMs: secondsToMilliseconds('300.000')! })).toEqual({})
})

it('compares JSON by values, ignoring object key order and whitespace but preserving array order', () => {
  const original = { enabled: true, headers: { Authorization: 'masked', Other: 'value' }, args: ['a', 'b'] }
  expect(jsonDraftChanged(original, '{"args":["a","b"],"headers":{"Other":"value","Authorization":"masked"},"enabled":true}')).toBe(false)
  expect(jsonDraftChanged(original, JSON.stringify({ ...original, args: ['b', 'a'] }))).toBe(true)
  expect(jsonDraftChanged(original, '{')).toBe(true)
  expect(jsonDraftChanged(original, '')).toBe(true)
  expect(settingsEqual({ optional: undefined }, {})).toBe(true)
  expect(settingsEqual({ optional: undefined, key: true }, { key: true })).toBe(true)
  expect(changedSettings({ packages: [{ source: 'npm:test', skills: ['a'] }] }, { packages: [{ skills: ['a'], source: 'npm:test' }] })).toEqual({})
})
