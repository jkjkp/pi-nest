import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getAgentDir: vi.fn(() => '/agent'), SettingsManager: { create: vi.fn() } }))
vi.mock('@earendil-works/pi-coding-agent', () => api)

function manager() {
  return {
    flush: vi.fn().mockResolvedValue(undefined),
    getCompactionEnabled: vi.fn(() => true), getDefaultModel: vi.fn(() => 'model'), getDefaultProvider: vi.fn(() => 'provider'), getDefaultThinkingLevel: vi.fn(() => 'high'), getFollowUpMode: vi.fn(() => 'all'), getProjectSettings: vi.fn(() => ({ defaultModel: 'project-model' })), getRetryEnabled: vi.fn(() => false), getSteeringMode: vi.fn(() => 'one-at-a-time'),
    setCompactionEnabled: vi.fn(), setDefaultModel: vi.fn(), setDefaultModelAndProvider: vi.fn(), setDefaultProvider: vi.fn(), setDefaultThinkingLevel: vi.fn(), setFollowUpMode: vi.fn(), setRetryEnabled: vi.fn(), setSteeringMode: vi.fn(),
  }
}

describe('Pi Settings adapter', () => {
  beforeEach(() => api.SettingsManager.create.mockReset())

  it('reads safe effective/global values and exposes the project layer as a value-only DTO', async () => {
    const instance = manager(); api.SettingsManager.create.mockReturnValue(instance)
    const { readPiSettings } = await import('./settings.js')
    expect(readPiSettings('/project')).toMatchObject({ effective: { defaultModel: 'model' }, global: { defaultProvider: 'provider' }, project: { defaultModel: 'project-model' } })
    expect(api.SettingsManager.create).toHaveBeenCalledWith('/project', '/agent')
  })

  it('only applies allowlisted global setters and flushes before returning the refreshed snapshot', async () => {
    const instance = manager(); api.SettingsManager.create.mockReturnValue(instance)
    const { updatePiSettings } = await import('./settings.js')
    await updatePiSettings('/project', { compactionEnabled: false, defaultModel: 'new-model', defaultProvider: 'new-provider', retryEnabled: true })
    expect(instance.setDefaultModelAndProvider).toHaveBeenCalledWith('new-provider', 'new-model')
    expect(instance.setCompactionEnabled).toHaveBeenCalledWith(false)
    expect(instance.setRetryEnabled).toHaveBeenCalledWith(true)
    expect(instance.flush).toHaveBeenCalledOnce()
  })
})
