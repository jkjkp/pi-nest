import { runPiConversationSpike } from '../src/conversation-spike.js'

const cwd = process.argv.slice(2).find((argument) => argument !== '--')

if (!cwd) {
  throw new Error('Usage: pnpm --filter @pi-nest/pi-adapter spike:conversation -- <cwd>')
}

let phase: 'complete' | 'abort' | undefined

const summary = await runPiConversationSpike(cwd, ({ delta, phase: nextPhase }) => {
  if (phase !== nextPhase) {
    phase = nextPhase
    console.log(`\n${nextPhase === 'complete' ? 'Completed response:' : 'Aborted response:'}`)
  }
  process.stdout.write(delta)
})

console.log(`\n${JSON.stringify(summary, null, 2)}`)
