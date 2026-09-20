import { restorePersistentPiSession } from '../src/index.js'

const sessionFile = process.argv.slice(2).find((argument) => argument !== '--')

if (!sessionFile) {
  throw new Error('Usage: pnpm --filter @pi-nest/pi-adapter spike:restore-persistent -- <session-file>')
}

console.log(JSON.stringify(await restorePersistentPiSession(sessionFile), null, 2))
