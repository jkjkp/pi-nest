import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const patch = JSON.parse(await readFile(new URL('./patches/ponytail-5.3.2-rpc-status.json', import.meta.url), 'utf8'))

export function patchPonytail(source, version) {
  if (version !== patch.version) throw new Error(`Ponytail ${version}: patch requires ${patch.version}; review the upstream implementation before applying`)
  if (source.includes(patch.after) && !source.includes(patch.before)) return source
  if (source.split(patch.before).length !== 2) throw new Error('Ponytail status source differs from the reviewed version; no files changed')
  return source.replace(patch.before, patch.after)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: node scripts/patch-ponytail.mjs /absolute/path/to/ponytail')
  const { version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const target = join(directory, 'pi-extension/index.js')
  const source = await readFile(target, 'utf8')
  const updated = patchPonytail(source, version)
  if (updated !== source) await writeFile(target, updated)
  console.log(updated === source ? 'Ponytail RPC status patch already applied.' : 'Ponytail RPC status patched. Reload the Pi runtime to activate.')
}
