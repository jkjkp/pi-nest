import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chmod, link, unlink } from 'node:fs/promises'
const require = createRequire(new URL('../apps/server/package.json', import.meta.url))
const Database = require('better-sqlite3')

export async function backupWorkspace(source, destination) {
  const target = resolve(destination)
  if (resolve(source) === target) throw new Error('备份目标不能覆盖源数据库')
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.backup`)
  const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    await db.backup(temporary); await chmod(temporary, 0o600)
    try { await link(temporary, target) }
    catch (cause) { if (cause.code === 'EEXIST') throw new Error('备份目标已存在，请选择新路径'); throw cause }
  } finally { db.close(); await unlink(temporary).catch((cause) => { if (cause.code !== 'ENOENT') throw cause }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destination, source = join(homedir(), '.pi-nest', 'workspace.sqlite')] = process.argv.slice(2)
  if (!destination) { console.error('用法：pnpm backup:workspace <新备份路径> [源数据库路径]'); process.exitCode = 1 }
  else { try { await backupWorkspace(source, destination); console.log('关系数据库备份完成。Pi 会话文件需另外备份。') } catch (cause) { console.error(cause.message); process.exitCode = 1 } }
}
