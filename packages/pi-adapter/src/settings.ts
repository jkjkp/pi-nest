import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'

export type PiRuntimeSettings = {
  compactionEnabled: boolean
  defaultModel?: string
  defaultProvider?: string
  defaultThinkingLevel?: string
  followUpMode: 'all' | 'one-at-a-time'
  retryEnabled: boolean
  steeringMode: 'all' | 'one-at-a-time'
}

export type PiSettingsSnapshot = { effective: PiRuntimeSettings; global: PiRuntimeSettings; project: Partial<PiRuntimeSettings> }
export type PiSettingsUpdate = Partial<PiRuntimeSettings>

function snapshot(manager: SettingsManager): PiRuntimeSettings {
  return {
    compactionEnabled: manager.getCompactionEnabled(),
    defaultModel: manager.getDefaultModel(),
    defaultProvider: manager.getDefaultProvider(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel(),
    followUpMode: manager.getFollowUpMode(),
    retryEnabled: manager.getRetryEnabled(),
    steeringMode: manager.getSteeringMode(),
  }
}

function projectSnapshot(manager: SettingsManager): Partial<PiRuntimeSettings> {
  const project = manager.getProjectSettings()
  return {
    compactionEnabled: project.compaction?.enabled,
    defaultModel: project.defaultModel,
    defaultProvider: project.defaultProvider,
    defaultThinkingLevel: project.defaultThinkingLevel,
    followUpMode: project.followUpMode,
    retryEnabled: project.retry?.enabled,
    steeringMode: project.steeringMode,
  }
}

export function readPiSettings(cwd: string): PiSettingsSnapshot {
  const manager = SettingsManager.create(cwd, getAgentDir())
  const global = snapshot(manager)
  return { effective: global, global, project: projectSnapshot(manager) }
}

export async function updatePiSettings(cwd: string, update: PiSettingsUpdate): Promise<PiSettingsSnapshot> {
  const manager = SettingsManager.create(cwd, getAgentDir())
  if (update.defaultProvider !== undefined && update.defaultModel !== undefined) manager.setDefaultModelAndProvider(update.defaultProvider, update.defaultModel)
  else {
    if (update.defaultProvider !== undefined) manager.setDefaultProvider(update.defaultProvider)
    if (update.defaultModel !== undefined) manager.setDefaultModel(update.defaultModel)
  }
  if (update.defaultThinkingLevel !== undefined) manager.setDefaultThinkingLevel(update.defaultThinkingLevel as never)
  if (update.steeringMode !== undefined) manager.setSteeringMode(update.steeringMode)
  if (update.followUpMode !== undefined) manager.setFollowUpMode(update.followUpMode)
  if (update.compactionEnabled !== undefined) manager.setCompactionEnabled(update.compactionEnabled)
  if (update.retryEnabled !== undefined) manager.setRetryEnabled(update.retryEnabled)
  await manager.flush()
  const global = snapshot(manager)
  return { effective: global, global, project: projectSnapshot(manager) }
}
