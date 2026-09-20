import { restorePiSession } from '../src/index.js'

const sessionFile = process.argv.slice(2).find((argument) => argument !== '--')

if (!sessionFile) {
  throw new Error('Usage: pnpm --filter @pi-nest/pi-adapter spike:restore -- <session-file>')
}

console.log(JSON.stringify(await restorePiSession(sessionFile), null, 2))
