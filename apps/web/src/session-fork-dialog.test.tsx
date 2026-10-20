// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionForkDialog } from './session-fork-dialog.js'
import { fetchSessionTurnIndex } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionTurnIndex: vi.fn() }))
let root: Root
let container: HTMLDivElement
let client: QueryClient
const onFork = vi.fn()
const onClose = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ revision: 'a'.repeat(64), entries: [{ id: 'user', index: 1, promptPreview: 'Question', startedAt: '2026-10-20T00:00:00Z' }] })
  onFork.mockReset(); onClose.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear(); container.remove(); vi.unstubAllGlobals()
})
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === text)! }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }

it('keeps a conflict visible until refresh succeeds and requires a new choice before retrying', async () => {
  onFork.mockRejectedValueOnce(new Error('会话历史已变化，请点击“刷新位置”后重新选择分叉消息。')).mockResolvedValue(undefined)
  await act(async () => root.render(<QueryClientProvider client={client}><SessionForkDialog sessionId="source" onFork={onFork} onClose={onClose} /></QueryClientProvider>))
  await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await act(async () => document.querySelector<HTMLInputElement>('input[type="radio"]')!.click())
  await act(async () => button('创建分支').click())
  expect(onFork).toHaveBeenCalledExactlyOnceWith('user', 'a'.repeat(64))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('刷新位置')
  expect(onClose).not.toHaveBeenCalled()
  let refresh!: (value: Awaited<ReturnType<typeof fetchSessionTurnIndex>>) => void
  vi.mocked(fetchSessionTurnIndex).mockReturnValueOnce(new Promise((resolve) => { refresh = resolve }))
  await act(async () => button('刷新位置').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('刷新位置')
  expect(button('创建分支').disabled).toBe(true)
  await act(async () => refresh({ revision: 'b'.repeat(64), entries: [{ id: 'user', index: 1, promptPreview: 'Question', startedAt: '2026-10-20T00:00:00Z' }] }))
  await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(button('创建分支').disabled).toBe(true)
  expect(onFork).toHaveBeenCalledTimes(1)
  await act(async () => document.querySelector<HTMLInputElement>('input[type="radio"]')!.click())
  await act(async () => button('创建分支').click())
  expect(onFork).toHaveBeenLastCalledWith('user', 'b'.repeat(64))
  expect(onClose).toHaveBeenCalledOnce()
})
