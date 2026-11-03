import { join } from 'node:path'
import { WorkspaceDatabase } from '../workspace-database.js'
import { SessionBranchStore } from '../session-branch-store.js'
import { SessionBranchService } from '../session-branch-service.js'
import { PiSessionIndex } from '../session-index.js'
import { AttachmentStore } from '../attachment-store.js'
const [directory, operationId] = process.argv.slice(2)
const db = new WorkspaceDatabase(join(directory, 'db.sqlite'))
const index = new PiSessionIndex({ directory, watch: false })
const source = (await index.resolve('source'))!
class InterruptedAttachments extends AttachmentStore {
  override inherit(): never { process.kill(process.pid, 'SIGKILL'); throw new Error('unreachable') }
}
new SessionBranchService(new SessionBranchStore(db), index, new InterruptedAttachments(join(directory, 'attachments'))).create(source, { kind: 'clone', operationId }, undefined, {})
process.exitCode = 2
