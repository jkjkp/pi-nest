import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

export async function createRestrictedAgentSession(sessionManager: SessionManager, cwd: string) {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await resourceLoader.reload()

  return createAgentSession({
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: 'all',
  })
}
