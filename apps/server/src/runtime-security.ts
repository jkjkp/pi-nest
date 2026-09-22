import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

function originFrom(value: string) {
  const origin = new URL(value)
  if (origin.origin !== value.replace(/\/$/, '')) throw new Error('PI_NEST_WEB_ORIGIN must be an origin without a path')
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new Error('PI_NEST_WEB_ORIGIN must use http or https')
  return origin.origin
}

export class RuntimeSecurity {
  readonly origin: string
  readonly runtimeId = randomUUID()
  readonly token = randomBytes(32).toString('base64url')

  constructor(origin = process.env.PI_NEST_WEB_ORIGIN ?? 'http://localhost:5173') {
    this.origin = originFrom(origin)
  }

  acceptsOrigin(origin: string | undefined) {
    return origin === this.origin
  }

  acceptsToken(token: string | undefined) {
    if (!token) return false
    const expected = Buffer.from(this.token)
    const received = Buffer.from(token)
    return expected.length === received.length && timingSafeEqual(expected, received)
  }
}
