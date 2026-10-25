import { execFile } from 'node:child_process'
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
try {
  $dialog.Description = '选择项目文件夹'
  $dialog.SelectedPath = $env:PI_NEST_PICKER_START
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}`
let selecting = false

export async function selectProjectFolder(cwd?: string): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('系统文件夹选择器目前仅支持 macOS 和 Windows。')
  if (selecting) throw new Error('已有文件夹选择窗口打开，请先完成或取消选择。')
  let start = resolveProjectDirectory(homedir())
  if (cwd) {
    try { start = resolveProjectDirectory(cwd) }
    catch { /* A removed or inaccessible previous folder must not prevent reselection. */ }
  }
  selecting = true
  try {
    const { stdout } = process.platform === 'win32'
      ? await executeFile(win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384, shell: false, windowsHide: true, env: { ...process.env, PI_NEST_PICKER_START: start } })
      : await executeFile('/usr/bin/osascript', ['-e', script, start], { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384 })
    const selected = stdout.replace(/\r?\n$/, '')
    return selected ? resolveProjectDirectory(selected) : null
  } finally { selecting = false }
}
