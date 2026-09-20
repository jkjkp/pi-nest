import { fileURLToPath } from 'node:url'

import { runPiCliSdkCliSpike } from '../src/cli-sdk-cli-spike.js'

const [sessionFile, cwd] = process.argv.slice(2).filter((argument) => argument !== '--')

if (!sessionFile || !cwd) {
  throw new Error('Usage: pnpm --filter @pi-nest/pi-adapter spike:cli-sdk-cli -- <session-file> <cwd>')
}

const piExecutable = fileURLToPath(new URL('../../node_modules/.bin/pi', import.meta.url))

console.log(
  JSON.stringify(
    await runPiCliSdkCliSpike({
      cwd,
      piExecutable,
      sessionFile,
    }),
    null,
    2,
  ),
)
