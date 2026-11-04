import { execFile, type ExecFileException } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
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
const windowsScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$owner = [System.Windows.Forms.Form]::new()
try {
  $owner.Text = 'Pi Nest - 选择项目文件夹'
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = [System.Drawing.Size]::new(1, 1)
  $owner.Opacity = 0
  $owner.TopMost = $true
  $owner.Show()
  $owner.Activate()
  $dialog.Description = '选择项目文件夹'
  $dialog.SelectedPath = $env:PI_NEST_PICKER_START
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}`
let selecting = false

export async function selectProjectFolder(cwd?: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('系统文件夹选择器目前仅支持 macOS 和 Windows。')
  if (selecting) throw Object.assign(new Error('已有文件夹选择窗口打开，请先完成或取消选择；也可手动输入绝对路径。'), { code: 'PROJECT_FOLDER_PICKER_BUSY' })
  let start = resolveProjectDirectory(homedir())
  if (cwd) {
    try { start = resolveProjectDirectory(cwd) }
    catch { /* A removed or inaccessible previous folder must not prevent reselection. */ }
  }
  selecting = true
  try {
    const selection = process.platform === 'win32'
      ? executeFile(win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384, shell: false, windowsHide: true, env: { ...process.env, PI_NEST_PICKER_START: start } })
      : executeFile('/usr/bin/osascript', ['-e', script, start], { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384 })
    // Kill directly: execFile's signal rejects before close, which would release the lock too early.
    const cancel = () => { selection.child.kill() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    try {
      const { stdout } = await selection
      if (signal?.aborted) return null
      const selected = stdout.replace(/\r?\n$/, '')
      return selected ? resolveProjectDirectory(selected) : null
    } catch (cause) {
      if (signal?.aborted) return null
      const error = cause as ExecFileException
      if (error.killed && error.signal === 'SIGTERM' && error.code === null) throw Object.assign(new Error('文件夹选择已超时，请重试或手动输入绝对路径。'), { code: 'PROJECT_FOLDER_PICKER_TIMEOUT' })
      throw cause
    } finally { signal?.removeEventListener('abort', cancel) }
  } finally { selecting = false }
}
