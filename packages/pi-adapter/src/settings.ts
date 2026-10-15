import type { PiRuntimeSettings, PiSettingsSnapshot, PiSettingsUpdate } from '@pi-nest/contracts'
export type { PiRuntimeSettings, PiSettingsSnapshot, PiSettingsUpdate } from '@pi-nest/contracts'

import { getAgentDir, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent'

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

function layerSnapshot(project: ReturnType<SettingsManager['getProjectSettings']>): Partial<PiRuntimeSettings> {
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
  const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: new ProjectTrustStore(getAgentDir()).get(cwd) === true })
  if (manager.drainErrors().length) throw new Error('Failed to load Pi settings')
  return { effective: snapshot(manager), global: layerSnapshot(manager.getGlobalSettings()), project: layerSnapshot(manager.getProjectSettings()) }
}

export async function updatePiSettings(cwd: string, update: PiSettingsUpdate): Promise<PiSettingsSnapshot> {
  const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: new ProjectTrustStore(getAgentDir()).get(cwd) === true })
  if (manager.drainErrors().length) throw new Error('Failed to load Pi settings')
  if (update.defaultProvider !== undefined && update.defaultModel !== undefined) manager.setDefaultModelAndProvider(update.defaultProvider, update.defaultModel)
  else {
    if (update.defaultProvider !== undefined) manager.setDefaultProvider(update.defaultProvider)
    if (update.defaultModel !== undefined) manager.setDefaultModel(update.defaultModel)
  }
  if (update.defaultThinkingLevel !== undefined) manager.setDefaultThinkingLevel(update.defaultThinkingLevel as Parameters<SettingsManager['setDefaultThinkingLevel']>[0])
  if (update.steeringMode !== undefined) manager.setSteeringMode(update.steeringMode)
  if (update.followUpMode !== undefined) manager.setFollowUpMode(update.followUpMode)
  if (update.compactionEnabled !== undefined) manager.setCompactionEnabled(update.compactionEnabled)
  if (update.retryEnabled !== undefined) manager.setRetryEnabled(update.retryEnabled)
  await manager.flush()
  if (manager.drainErrors().length) throw new Error('Failed to load Pi settings')
  return { effective: snapshot(manager), global: layerSnapshot(manager.getGlobalSettings()), project: layerSnapshot(manager.getProjectSettings()) }
}
