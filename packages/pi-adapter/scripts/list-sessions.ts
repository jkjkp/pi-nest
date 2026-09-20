import { listPiSessions } from '../src/index.js'

const sessions = await listPiSessions()

console.log(JSON.stringify({ count: sessions.length, sessions }, null, 2))
