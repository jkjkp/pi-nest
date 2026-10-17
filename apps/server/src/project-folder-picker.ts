import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { resolveProjectDirectory } from './project-registry.js'

const executeFile = promisify(execFile)
const script = `on run argv
  try
    set selectedFolder to choose folder with prompt "选择项目文件夹" default location (POSIX file (item 1 of argv)) without multiple selections allowed
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run`
let selecting = false

export async function selectProjectFolder(cwd?: string): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('系统文件夹选择器目前仅支持 macOS。')
  if (selecting) throw new Error('已有文件夹选择窗口打开，请先完成或取消选择。')
  let start = resolveProjectDirectory(homedir())
  if (cwd) {
    try { start = resolveProjectDirectory(cwd) }
    catch { /* A removed or inaccessible previous folder must not prevent reselection. */ }
  }
  selecting = true
  try {
    const { stdout } = await executeFile('/usr/bin/osascript', ['-e', script, start], { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384 })
    const selected = stdout.replace(/\r?\n$/, '')
    return selected ? resolveProjectDirectory(selected) : null
  } finally { selecting = false }
}
