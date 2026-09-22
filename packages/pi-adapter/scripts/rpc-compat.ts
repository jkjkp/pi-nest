import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { runPiRpcCompatibilitySpike } from '../src/pi-rpc-compatibility-spike.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '../..')
const result = await runPiRpcCompatibilitySpike({
  cwd: resolve(packageRoot, 'fixtures/rpc-parity-project'),
  piExecutable: resolve(packageRoot, 'node_modules/.bin/pi'),
})

// Deliberately excludes raw stdout. The temporary raw log is deleted by the spike.
console.log(JSON.stringify(result, null, 2))
if (result.outcome !== 'passed') process.exitCode = 2
