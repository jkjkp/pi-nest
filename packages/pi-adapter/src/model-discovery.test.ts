import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPiModels, piSecretPlaceholder } from './configuration.js'
let directory: string
const fetchMock = vi.fn<typeof fetch>()
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'pi-nest-discovery-')); vi.stubEnv('PI_CODING_AGENT_DIR', directory); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })
it('builds OpenAI URLs, resolves env references and returns only deduplicated model ids', async () => {
  vi.stubEnv('PI_NEST_FIXTURE_KEY', 'fixture-key')
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'two', apiKey: 'not-returned', contextWindow: 123 }, { id: 'one' }, { id: 'two' }, { invalid: true }] })))
  expect(await discoverPiModels({ provider: 'fixture', connection: { baseUrl: 'http://localhost:11434/v1/', api: 'openai-completions', apiKey: '${PI_NEST_FIXTURE_KEY}' } })).toEqual([{ id: 'one' }, { id: 'two' }])
  const [url, options] = fetchMock.mock.calls[0]
  expect(String(url)).toBe('http://localhost:11434/v1/models')
  expect((options?.headers as Headers).get('authorization')).toBe('Bearer fixture-key')
  expect(options?.redirect).toBe('error')
})
it('restores masked saved credentials and uses Anthropic headers and its v1 path', async () => {
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { saved: { apiKey: 'saved-key' } } }))
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude', display_name: 'Claude' }] })))
  expect(await discoverPiModels({ provider: 'saved', connection: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: piSecretPlaceholder } })).toEqual([{ id: 'claude', name: 'Claude' }])
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/models')
  expect((fetchMock.mock.calls[0][1]?.headers as Headers).get('x-api-key')).toBe('saved-key')
})
it('never executes credential commands or fetches unsupported urls and masks upstream failures', async () => {
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'file:///etc', api: 'openai-responses' } })).rejects.toThrow('HTTP')
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'http://localhost/v1', api: 'openai-responses', apiKey: '!echo key' } })).rejects.toThrow('不执行')
  expect(fetchMock).not.toHaveBeenCalled()
  vi.stubEnv('PI_NEST_DISCOVERY_UNSET', undefined)
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'https://example.com/v1', api: 'openai-responses', apiKey: '${PI_NEST_DISCOVERY_UNSET}' } })).rejects.toThrow('未设置')
  fetchMock.mockResolvedValue(new Response('secret upstream error', { status: 401 }))
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'https://example.com/v1', api: 'openai-responses' } })).rejects.toThrow('认证失败')
})
it('rejects oversized or nonstandard response bodies while keeping manual setup available', async () => {
  fetchMock.mockResolvedValueOnce(new Response('private', { headers: { 'content-length': '2000001' } }))
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'http://localhost/v1', api: 'openai-responses' } })).rejects.toThrow('过大')
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'one' }], has_more: true })))
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'http://localhost/v1', api: 'openai-responses' } })).rejects.toThrow('分页')
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ unsupported: true })))
  await expect(discoverPiModels({ provider: 'new', connection: { baseUrl: 'http://localhost/v1', api: 'openai-responses' } })).rejects.toThrow('手动添加')
})
