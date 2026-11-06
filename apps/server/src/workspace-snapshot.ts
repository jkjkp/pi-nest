import type { PiWorkspaceSnapshot } from '@pi-nest/contracts'
import type { ProjectRegistry } from './project-registry.js'
import type { SessionIndex } from './session-index.js'
import type { SessionBranchStore } from './session-branch-store.js'
import type { AttachmentStore } from './attachment-store.js'
import { resolveSessionLineage } from './session-lineage.js'

export async function workspaceSnapshot(projects: ProjectRegistry, index: SessionIndex, branches: SessionBranchStore, attachments: AttachmentStore): Promise<PiWorkspaceSnapshot> {
  const native = await index.list()
  const projectIds = projects.sync(native)
  const sessions = resolveSessionLineage(native, branches.relations())
  return {
    projects: projects.list(),
    sessions: sessions.map(({ id, cwd, name, firstMessage, createdAt, updatedAt, parentSessionId, parentSessionMissing, branch }) => ({
      id, cwd, name, firstMessage: attachments.displayPrompt(firstMessage, id), createdAt, updatedAt,
      parentSessionId, parentSessionMissing, branch, projectId: projectIds.get(id),
    })),
    branchStorage: { available: branches.health.available },
  }
}
