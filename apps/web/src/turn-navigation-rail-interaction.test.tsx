import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { TurnNavigationRail } from './turn-navigation-rail.js'

const { setOpen, hooks } = vi.hoisted(() => ({ setOpen: vi.fn(), hooks: { index: 0 } }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (value: unknown) => hooks.index++ === 0 ? [true, setOpen] : [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
}))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => ({ getTotalSize: () => 56, getVirtualItems: () => [{ index: 0, start: 0 }], scrollToIndex: vi.fn() }) }))

beforeEach(() => setOpen.mockClear())
afterEach(() => vi.unstubAllGlobals())

function setup(onJump = vi.fn(async (_id: string) => undefined)) {
  const entries = [1, 2].map(index => ({ id: `turn-${index}`, index, promptPreview: `prompt ${index}`, startedAt: '2026-10-12T00:00:00Z' }))
  hooks.index = 0
  const rail = TurnNavigationRail({ entries, onJump }) as ReactElement<any>
  const panel = rail.props.children[1]
  const row = panel.props.children[0].props.children.props.children[0]
  return { rail, button: row.props.children[0], onJump }
}

it('keeps history open after repeated successful mouse jumps and focus leaves', async () => {
  const { rail, button, onJump } = setup()
  rail.props.onPointerEnter({ pointerType: 'mouse' })
  await button.props.onClick()
  await button.props.onClick()
  rail.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null })
  expect(onJump).toHaveBeenCalledTimes(2)
  expect(setOpen).not.toHaveBeenCalledWith(false)
})

it('keeps history open when an async jump fails', async () => {
  const { button } = setup(vi.fn(async () => { throw new Error('failed') }))
  await button.props.onClick()
  expect(setOpen).not.toHaveBeenCalledWith(false)
})

it('closes only when the pointer leaves the whole region', () => {
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLElement', class {})
  const { rail } = setup()
  rail.props.onPointerEnter({ pointerType: 'mouse' })
  rail.props.onPointerLeave({ currentTarget: { contains: () => true }, relatedTarget: {} })
  expect(setOpen).not.toHaveBeenCalledWith(false)
  rail.props.onPointerLeave({ currentTarget: { contains: () => false }, relatedTarget: null })
  expect(setOpen).toHaveBeenCalledWith(false)
})
