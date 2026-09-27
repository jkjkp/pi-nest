import { describe, expect, it } from 'vitest'

import { timelineNavigationTurns } from './timeline-navigation.js'

describe('timelineNavigationTurns', () => {
  it('uses persisted turns as the complete base and appends an unpersisted running turn', () => {
    const turns = timelineNavigationTurns([
      { id: 'user-1', index: 1, promptPreview: 'first', startedAt: 'one' },
      { id: 'user-2', index: 2, promptPreview: 'second', startedAt: 'two' },
    ], [
      { diagnostics: [], events: [], id: 'user-2', kind: 'turn', parts: [], prompt: 'second', startedAt: 'two' },
      { diagnostics: [], events: [], id: 'pending-3', kind: 'turn', parts: [], prompt: 'third', startedAt: 'three' },
    ])

    expect(turns).toEqual([
      expect.objectContaining({ id: 'user-1', index: 1, state: 'persisted' }),
      expect.objectContaining({ id: 'user-2', index: 2, state: 'persisted' }),
      expect.objectContaining({ id: 'pending-3', index: 3, state: 'running' }),
    ])
  })

  it('uses loaded turns as the only navigation source until an index arrives', () => {
    const turns = timelineNavigationTurns(undefined, [
      { diagnostics: [], events: [], id: 'pending-1', kind: 'turn', parts: [], prompt: 'first', startedAt: 'one' },
    ])

    expect(turns).toEqual([expect.objectContaining({ id: 'pending-1', index: 1, state: 'running' })])
  })
})
