import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PiConfigurationConflict, piSecretPlaceholder, redactPiConfiguration, restorePiSecrets, updatePiConfigDocument } from './configuration.js'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-nest-config-')); directories.push(dir)
  const path = join(dir, 'models.json')
  const data = { untouched: { keep: true }, providers: { one: { apiKey: 'secret', models: [{ id: 'one' }] }, two: { baseUrl: 'http://localhost/v1' } } }
  const text = JSON.stringify(data)
  await writeFile(path, text)
  return { path, data, text, revision: createHash('sha256').update(text).digest('hex') }
}
describe('Pi config document writes', () => {
  it('redacts nested secrets, environment values, arguments and URL credentials without executing commands', () => {
    const secret = { headers: { custom: 'private' }, env: { CUSTOM: '!touch /tmp/no' }, apiKey: 'value', oauth: { clientSecret: 'secret' }, args: ['--token', 'secret'], url: 'https://user:pass@example.com/mcp' }
    const safe = redactPiConfiguration(secret)
    expect(JSON.stringify(safe)).not.toContain('private')
    expect(JSON.stringify(safe)).not.toContain('touch')
    expect(JSON.stringify(safe)).not.toContain('user:pass')
    expect(restorePiSecrets(safe, secret)).toEqual(secret)
    expect(() => restorePiSecrets({ apiKey: piSecretPlaceholder }, {})).toThrow()
    expect(() => restorePiSecrets(JSON.parse('{"__proto__":{}}'), {})).toThrow()
  })
  it('preserves other entries and unknown fields while restoring a masked key', async () => {
    const { path, data, revision } = await fixture()
    await updatePiConfigDocument(path, 'providers', { revision, name: 'one', value: { apiKey: piSecretPlaceholder, models: [{ id: 'new' }] } })
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.untouched).toEqual(data.untouched)
    expect(saved.providers.two).toEqual(data.providers.two)
    expect(saved.providers.one.apiKey).toBe('secret')
    expect(saved.providers.one.models).toEqual([{ id: 'new' }])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('rejects stale revisions and validation failures without modifying the file', async () => {
    const { path, text, revision } = await fixture()
    await expect(updatePiConfigDocument(path, 'providers', { revision: 'stale', name: 'one', value: null })).rejects.toBeInstanceOf(PiConfigurationConflict)
    await expect(updatePiConfigDocument(path, 'providers', { revision, name: 'one', value: {} }, async () => { throw new Error('invalid') })).rejects.toThrow('invalid')
    expect(await readFile(path, 'utf8')).toBe(text)
    await expect(updatePiConfigDocument(path, 'providers', { revision, name: 'one', value: {} }, async () => { await writeFile(path, '{"providers":{}}') })).rejects.toBeInstanceOf(PiConfigurationConflict)
    expect(await readFile(path, 'utf8')).toBe('{"providers":{}}')
  })
})

it('uses Pi 1.2 native APIs against isolated configuration, including persistent credentials', async () => {
  const { vi } = await import('vitest')
  const { readPiConfiguration, updatePiConfiguration } = await import('./configuration.js')
  const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent')
  const dir = await mkdtemp(join(tmpdir(), 'pi-nest-native-')); directories.push(dir)
  const project = join(dir, 'project')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(project, '.pi'), { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'global', retry: { enabled: false } }))
  await writeFile(join(project, '.pi/settings.json'), JSON.stringify({ defaultModel: 'project', retry: { enabled: true } }))
  vi.stubEnv('PI_CODING_AGENT_DIR', dir)
  vi.stubEnv('PI_OFFLINE', '1')
  try {
    let snapshot = await readPiConfiguration(project)
    expect(snapshot.projectTrusted).toBe(false)
    expect(snapshot.settings.effective.defaultModel).toBe('global')
    new ProjectTrustStore(dir).set(project, true)
    snapshot = await readPiConfiguration(project)
    expect(snapshot.settings.global.defaultModel).toBe('global')
    expect(snapshot.settings.effective.defaultModel).toBe('project')
    await updatePiConfiguration(project, { category: 'credentials', provider: 'anthropic', apiKey: 'fixture-not-a-real-key' })
    const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'fixture-not-a-real-key' })
    snapshot = await readPiConfiguration(project)
    expect(JSON.stringify(snapshot)).not.toContain('fixture-not-a-real-key')
    expect(snapshot.providers.find((provider) => provider.id === 'anthropic')?.credentialType).toBe('api_key')
    await updatePiConfiguration(project, { category: 'custom-models', scope: 'global', revision: snapshot.customModels.revision, name: 'local', value: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'local', models: [{ id: 'fixture' }] } })
    snapshot = await readPiConfiguration(project)
    expect(snapshot.models.some((model) => model.id === 'fixture' && model.provider === 'local')).toBe(true)
    await updatePiConfiguration(project, { category: 'resources', scope: 'project', values: { skills: ['skills'] } })
    await updatePiConfiguration(project, { category: 'advanced', values: { transport: 'sse', enableSkillCommands: false } })
    snapshot = await readPiConfiguration(project)
    expect(snapshot.projectResources?.skills).toEqual(['skills'])
    expect(snapshot.advanced.transport).toBe('sse')
    await updatePiConfiguration(project, { category: 'credentials', provider: 'anthropic', apiKey: null })
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).anthropic).toBeUndefined()
  } finally { vi.unstubAllEnvs() }
})

it('diagnoses a real isolated stdio MCP through the bundled CLI without exposing config or errors', async () => {
  const { vi } = await import('vitest')
  const { diagnosePiMcp } = await import('./configuration.js')
  const dir = await mkdtemp(join(tmpdir(), 'pi-nest-mcp-')); directories.push(dir)
  const server = join(dir, 'fixture.mjs')
  await writeFile(server, `import readline from 'node:readline';
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : message.method === 'tools/list' ? {tools:[{name:'fixture_read',description:'Fixture',inputSchema:{type:'object'}}]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`)
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }))
  vi.stubEnv('PI_CODING_AGENT_DIR', dir)
  vi.stubEnv('PI_OFFLINE', '1')
  try {
    const result = await diagnosePiMcp(dir)
    expect(result.hasErrors).toBe(false)
    expect(result.servers).toEqual([{ name: 'fixture', state: 'connected', tools: ['fixture_read'] }])
    expect(JSON.stringify(result)).not.toContain(dir)
  } finally { vi.unstubAllEnvs() }
}, 20_000)
