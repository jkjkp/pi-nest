// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SessionGraphCanvas } from './session-graph-canvas.js'
import type { GraphNode } from './session-graph-model.js'

const nodes: GraphNode[] = ['current', 'preview', 'ordinary'].map((id, i) => ({
  id, label: id, summary: '摘要', x: 24 + i * 280, y: 24, hasChildren: false, collapsed: false,
  status: i === 0 ? '推理中' : i === 1 ? '失败' : '空闲',
}))
function render(current = 'current', preview?: string) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<SessionGraphCanvas nodes={nodes} selectedSessionId={current} selectedNodeId={preview} locateRequest={0} onSelect={() => {}} onToggle={() => {}} onLocate={() => {}} />)
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
