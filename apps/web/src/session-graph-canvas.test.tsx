// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionGraphCanvas } from './session-graph-canvas.js'
import type { GraphNode } from './session-graph-model.js'

const nodes: GraphNode[] = ['current', 'preview', 'ordinary'].map((id, i) => ({
  id, label: id, summary: '摘要', x: 24 + i * 280, y: 24, hasChildren: false, collapsed: false,
  status: i === 0 ? '推理中' : i === 1 ? '失败' : '空闲',
}))
function render(current = 'current', preview?: string) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<SessionGraphCanvas renderNodeMenu={() => null} nodes={nodes} selectedSessionId={current} selectedNodeId={preview} locateRequest={0} onSelect={() => {}} onToggle={() => {}} onLocate={() => {}} />)
  return (id: string) => container.querySelector<HTMLButtonElement>(`[data-session-node="${id}"] > button[title]`)!
}
it('distinguishes the send target, read-only preview and ordinary nodes while retaining run statuses', () => {
  const node = render('current', 'preview')
  expect(node('current').getAttribute('data-node-state')).toBe('current')
  expect(node('current').getAttribute('aria-current')).toBe('true')
  expect(node('current').textContent).toContain('当前会话')
  expect(node('current').textContent).toContain('推理中')
  expect(node('preview').getAttribute('data-node-state')).toBe('preview')
  expect(node('preview').getAttribute('aria-pressed')).toBe('true')
  expect(node('preview').textContent).toContain('只读预览')
  expect(node('preview').textContent).toContain('失败')
  expect(node('preview').querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(node('ordinary').getAttribute('data-node-state')).toBe('idle')
  expect(node('ordinary').textContent).toContain('空闲')
  expect(node('ordinary').getAttribute('aria-current')).toBeNull()
})
it('moves the current identity after an explicit session switch and clears the preview identity', () => {
  const node = render('preview')
  expect(node('current').getAttribute('data-node-state')).toBe('idle')
  expect(node('preview').getAttribute('data-node-state')).toBe('current')
  expect(node('preview').getAttribute('aria-pressed')).toBe('false')
  expect(node('preview').textContent).not.toContain('只读预览')
})
it('keeps the current identity when a stale preview id equals the send target', () => {
  const node = render('current', 'current')
  expect(node('current').getAttribute('data-node-state')).toBe('current')
  expect(node('current').getAttribute('aria-pressed')).toBe('false')
  expect(node('current').textContent).not.toContain('只读预览')
})

async function withCanvas(check: (fixture: {
  container: HTMLDivElement; update: (current: string, nextNodes?: GraphNode[], locate?: number) => Promise<void>
  transform: () => string; position: (id: string) => { x: number; y: number }; unmount: () => Promise<void>
}) => Promise<void>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const transform = () => container.querySelector<HTMLElement>('[aria-label="会话分支画布，方向键平移，点击节点查看会话"] > div')!.style.transform
  const position = (id: string) => {
    const node = container.querySelector<HTMLElement>(`[data-session-node="${id}"]`)!
    const [x, y, scale] = transform().match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
    return { x: Number.parseFloat(node.style.left) * scale + x, y: Number.parseFloat(node.style.top) * scale + y }
  }
  async function update(current: string, nextNodes = nodes, locate = 0) {
    await act(async () => root.render(<SessionGraphCanvas renderNodeMenu={() => null} nodes={nextNodes} selectedSessionId={current} locateRequest={locate} onSelect={() => {}} onToggle={() => {}} onLocate={() => {}} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
  let mounted = true
  async function unmount() { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try { await update('current'); await check({ container, update, transform, position, unmount }) }
  finally { await unmount(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
}

it('keeps the viewport and mounted cards when switching to an already visible current node', async () => {
  await withCanvas(async ({ container, update, transform }) => {
    const before = transform()
    const card = container.querySelector('[data-session-node="current"]')
    await update('preview')
    expect(transform()).toBe(before)
    expect(container.querySelector('[data-session-node="current"]')).toBe(card)
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('title')).toBe('preview')
  })
})

it('anchors the existing current node on screen when deletion changes the tree layout', async () => {
  await withCanvas(async ({ update, position }) => {
    const before = position('current')
    await update('current', nodes.map((node) => ({ ...node, y: node.y + 164 })))
    expect(position('current')).toEqual(before)
  })
})

it('still locates the current node when the user explicitly requests it', async () => {
  await withCanvas(async ({ update, position }) => {
    await update('preview')
    await update('preview', nodes, 1)
    expect(position('preview')).toEqual({ x: 24, y: 48 })
  })
})

it('keeps the new current card visible after switching while the narrow-screen canvas is hidden', async () => {
  let resize!: (width: number, height: number) => void
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries: { contentRect: { width: number; height: number } }[]) => void) { resize = (width, height) => callback([{ contentRect: { width, height } }]) }
    observe() {}
    disconnect() {}
  })
  await withCanvas(async ({ update, position }) => {
    await act(async () => resize(500, 400))
    await act(async () => resize(0, 0))
    await update('preview')
    await act(async () => resize(500, 400))
    const point = position('preview')
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.x + 260).toBeLessThanOrEqual(500)
    expect(point.y + 132).toBeLessThanOrEqual(400)
  })
})

const viewport = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-label="会话分支画布，方向键平移，点击节点查看会话"]')!
const camera = (transform: () => string) => {
  const [x, y, scale] = transform().match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
  return { x, y, scale }
}
function wheelEvent(deltaY: number, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: 480, clientY: 300, ...options })
  // happy-dom's WheelEvent lacks the MouseEvent coordinates provided by browsers.
  Object.defineProperties(event, { clientX: { value: options.clientX ?? 480 }, clientY: { value: options.clientY ?? 300 } })
  return event
}
async function wheel(target: HTMLElement, deltaY: number, options: WheelEventInit = {}) {
  const event = wheelEvent(deltaY, options)
  await act(async () => target.dispatchEvent(event))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  return event
}

it.each(['blank', 'svg', 'toolbar'] as const)('suppresses the browser context menu on the %s canvas surface', async (surface) => {
  await withCanvas(async ({ container }) => {
    const target = surface === 'blank' ? viewport(container) : surface === 'svg' ? container.querySelector('svg')! : container.querySelector('button[aria-label="缩小树状画布"]')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => target.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

it('leaves the context menu outside the canvas untouched', async () => {
  await withCanvas(async ({ container }) => {
    const outside = document.createElement('button'); container.append(outside)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => outside.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })
})

it.each([0, 1, 2])('zooms wheel input in both directions for deltaMode %s and prevents page scrolling', async (deltaMode) => {
  await withCanvas(async ({ container, transform }) => {
    const target = viewport(container)
    const before = camera(transform).scale
    const up = await wheel(target, -1, { deltaMode })
    const enlarged = camera(transform).scale
    expect(enlarged).toBeGreaterThan(before)
    expect(up.defaultPrevented).toBe(true)
    const down = await wheel(target, 1, { deltaMode })
    expect(camera(transform).scale).toBeLessThan(enlarged)
    expect(down.defaultPrevented).toBe(true)
  })
})

it('normalizes line and page wheel units instead of treating them as single pixels', async () => {
  const scales: number[] = []
  for (const deltaMode of [0, 1, 2]) await withCanvas(async ({ container, transform }) => {
    await wheel(viewport(container), -1, { deltaMode })
    scales.push(camera(transform).scale)
  })
  expect(scales[1]).toBeGreaterThan(scales[0])
  expect(scales[2]).toBeGreaterThan(scales[1])
})

it('keeps the graph point under the mouse fixed while zooming in an offset viewport', async () => {
  await withCanvas(async ({ container, transform }) => {
    const target = viewport(container)
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 80, 800, 600))
    const before = camera(transform)
    const point = { x: (360 - before.x) / before.scale, y: (220 - before.y) / before.scale }
    await wheel(target, -60)
    const after = camera(transform)
    expect(after.scale).toBeGreaterThan(before.scale)
    expect((360 - after.x) / after.scale).toBeCloseTo(point.x, 8)
    expect((220 - after.y) / after.scale).toBeCloseTo(point.y, 8)
  })
})

it('accumulates consecutive wheel events before React renders instead of dropping an event', async () => {
  await withCanvas(async ({ container, transform }) => {
    const target = viewport(container)
    const before = camera(transform).scale
    await wheel(target, -10)
    const once = camera(transform).scale
    await act(async () => {
      for (let index = 0; index < 2; index++) target.dispatchEvent(wheelEvent(-10))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    expect(once).toBeGreaterThan(before)
    expect(camera(transform).scale - once).toBeGreaterThan((once - before) * 1.5)
  })
})

it('clamps wheel zoom to 1–200 percent', async () => {
  await withCanvas(async ({ container, transform }) => {
    const target = viewport(container)
    for (const [deltaY, expected] of [[-1_000_000, 2], [1_000_000, 0.01]]) {
      await act(async () => {
        for (let index = 0; index < 40; index++) target.dispatchEvent(wheelEvent(deltaY))
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
      expect(camera(transform).scale).toBe(expected)
    }
  })
})

it('ignores purely horizontal wheel input', async () => {
  await withCanvas(async ({ container, transform }) => {
    const before = transform()
    await wheel(viewport(container), 0, { deltaX: 120 })
    expect(transform()).toBe(before)
  })
})

it('removes wheel handling when the canvas unmounts', async () => {
  await withCanvas(async ({ container, unmount }) => {
    const target = viewport(container)
    expect((await wheel(target, -10)).defaultPrevented).toBe(true)
    await unmount()
    expect((await wheel(target, -10)).defaultPrevented).toBe(false)
  })
})

it.each(['zoom', 'pan'] as const)('preserves pending wheel input when immediately followed by %s', async (action) => {
  const results: ReturnType<typeof camera>[] = []
  for (const interleaved of [false, true]) await withCanvas(async ({ container, transform }) => {
    const frames = new Map<number, FrameRequestCallback>(); let sequence = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const paint = () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) })
    const target = viewport(container)
    await act(async () => target.dispatchEvent(wheelEvent(-60)))
    if (!interleaved) await paint()
    await act(async () => {
      if (action === 'zoom') container.querySelector<HTMLButtonElement>('[aria-label="放大树状画布"]')!.click()
      else target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await paint()
    results.push(camera(transform))
  })
  expect(results[1].scale).toBeCloseTo(results[0].scale, 8)
  expect(results[1].x).toBeCloseTo(results[0].x, 8)
  expect(results[1].y).toBeCloseTo(results[0].y, 8)
})

it('stops canvas panning after pointer cancellation without undoing wheel zoom', async () => {
  await withCanvas(async ({ container, transform }) => {
    const target = viewport(container)
    target.setPointerCapture = vi.fn()
    await act(async () => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 })))
    await act(async () => target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 140, clientY: 130 })))
    await wheel(target, -60)
    const before = transform()
    await act(async () => {
      target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 200, clientY: 200 }))
    })
    expect(transform()).toBe(before)
  })
})
