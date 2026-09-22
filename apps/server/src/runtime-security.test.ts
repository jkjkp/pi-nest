import { describe, expect, it } from 'vitest'

import { RuntimeSecurity } from './runtime-security.js'

describe('RuntimeSecurity', () => {
  it('accepts only the configured origin and its startup token', () => {
    const security = new RuntimeSecurity('http://localhost:5173')
    expect(security.acceptsOrigin('http://localhost:5173')).toBe(true)
    expect(security.acceptsOrigin('http://127.0.0.1:5173')).toBe(false)
    expect(security.acceptsOrigin(undefined)).toBe(false)
    expect(security.acceptsToken(security.token)).toBe(true)
    expect(security.acceptsToken('wrong')).toBe(false)
  })
})
