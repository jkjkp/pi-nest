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
  transform: () => string; position: (id: string) => { x: number; y: number }
}) => Promise<void>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const transform = () => container.querySelector<HTMLElement>('[data-session-node]')!.parentElement!.style.transform
  const position = (id: string) => {
    const node = container.querySelector<HTMLElement>(`[data-session-node="${id}"]`)!
    const [x, y, scale] = transform().match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    return { x: Number.parseFloat(node.style.left) * scale + x, y: Number.parseFloat(node.style.top) * scale + y }
  }
  async function update(current: string, nextNodes = nodes, locate = 0) {
    await act(async () => root.render(<SessionGraphCanvas renderNodeMenu={() => null} nodes={nextNodes} selectedSessionId={current} locateRequest={locate} onSelect={() => {}} onToggle={() => {}} onLocate={() => {}} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
  try { await update('current'); await check({ container, update, transform, position }) }
  finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
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
