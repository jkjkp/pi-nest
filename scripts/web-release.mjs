import { cp, mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function stageWebRelease(source) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-nest-web-'))
  try {
    await chmod(directory, 0o700)
    await cp(source, directory, { recursive: true, force: false })
    return directory
  } catch (cause) { await rm(directory, { force: true, recursive: true }); throw cause }
}
