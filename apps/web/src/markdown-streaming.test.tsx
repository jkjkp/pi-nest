// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from './assistant-markdown.js'
import { LegacyMarkdown } from '../perf/legacy-markdown.js'
import { boundaryMarkdown, prefixes } from '../perf/markdown-fixtures.js'
import { runtimeFixture } from '../perf/runtime-fixture.js'
import { createSessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'
import { timelineItems } from './timeline-model.js'
import { projectTurnPresentation } from './turn-execution-model.js'
import * as pipeline from './markdown-pipeline.js'
import { SessionTimeline } from './session-timeline.js'
import type { RuntimeTurn } from './session-run-model.js'

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (options: { count: number; getItemKey: (index: number) => string }) => ({
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 240 })),
  getVirtualItemForOffset: () => ({ index: 1 }), getTotalSize: () => options.count * 240, measureElement: () => {}, scrollToIndex: () => {},
}) }))

let live: HTMLDivElement
let baseline: HTMLDivElement
let root: ReturnType<typeof createRoot>
let oracle: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  live = document.createElement('div')
  baseline = document.createElement('div')
  document.body.append(live, baseline)
  root = createRoot(live)
  oracle = createRoot(baseline)
})
afterEach(async () => {
  await act(() => { root.unmount(); oracle.unmount() })
  live.remove(); baseline.remove(); vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('matches the mounted legacy renderer at code-unit prefixes under StrictMode', async () => {
  const source = boundaryMarkdown + '\n\n[a][ref]\n\n[ref]: https://example.com\n\nend'
  for (const text of prefixes(source, 7)) {
    await act(() => {
      root.render(<StrictMode><AssistantMarkdown source={text} isStreaming /></StrictMode>)
      oracle.render(<LegacyMarkdown source={text} isStreaming />)
    })
    expect(live.innerHTML).toBe(baseline.innerHTML)
  }
})

it('retains DOM, wrapping, copy feedback and scroll position through freezing and settlement', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const start = '```unknown\n  code\n```'
  const render = (source: string, isStreaming: boolean) => act(() => root.render(<StrictMode><AssistantMarkdown source={source} isStreaming={isStreaming} /></StrictMode>))
  await render(start, true)
  const pre = live.querySelector('pre')!
  const wrap = live.querySelector<HTMLButtonElement>('[aria-label="自动换行"]')!
  const copy = live.querySelector<HTMLButtonElement>('[aria-label="复制代码"]')!
  pre.scrollTop = 17
  await act(() => { wrap.click(); copy.click() })
  for (const streaming of [true, false, true, false]) {
    await render(start + '\n\none\n\ntwo\n\nthree\n\nfour', streaming)
    expect(live.querySelector('pre')).toBe(pre)
    expect(live.querySelector('[aria-label="自动换行"]')).toBe(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    expect(copy.getAttribute('title')).toBe('已复制')
    expect(pre.scrollTop).toBe(17)
  }
  expect(writeText).toHaveBeenCalledWith('  code')
})

it('does not parse the same source again when a turn settles or re-enters streaming', async () => {
  const parse = vi.spyOn(pipeline, 'parseMarkdown')
  const source = 'one\n\ntwo\n\nthree\n\nfour'
  for (const isStreaming of [true, false, true, false]) {
    await act(() => root.render(<AssistantMarkdown source={source} isStreaming={isStreaming} />))
    expect(parse).toHaveBeenCalledTimes(1)
  }
  await act(() => root.render(<AssistantMarkdown source={source + '\n\nfive'} isStreaming />))
  expect(parse).toHaveBeenCalledTimes(2)
})

it('updates local-link callbacks even on frozen nodes and blocks dangerous destinations', async () => {
  const first = vi.fn(), second = vi.fn()
  const source = '[local](src/a.ts#L2) [bad](javascript:alert) [remote](//evil.test)\n\none\n\ntwo\n\nthree'
  await act(() => root.render(<AssistantMarkdown source={source} isStreaming onOpenLocalLink={first} />))
  const local = [...live.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'local')!
  await act(() => local.click())
  expect(first).toHaveBeenCalledWith('src/a.ts#L2')
  await act(() => root.render(<AssistantMarkdown source={source + '\n\nfour'} isStreaming onOpenLocalLink={second} />))
  expect(live.querySelector('button')).toBe(local)
  await act(() => local.click())
  expect(second).toHaveBeenCalledWith('src/a.ts#L2')
  expect(live.innerHTML).not.toContain('javascript:')
  expect(live.innerHTML).not.toContain('//evil.test')
  await act(() => root.render(<AssistantMarkdown source={source} isStreaming />))
  expect(live.querySelector('button')).toBeNull()
})

it('recovers from replacement, truncation and completion without stale blocks', async () => {
  for (const [source, isStreaming] of [['one\n\ntwo\n\nthree\n\nfour', true], ['other', true], ['', true], ['```unknown\nnew\n```', false], ['new stream', true]] as const) {
    await act(() => { root.render(<AssistantMarkdown source={source} isStreaming={isStreaming} />); oracle.render(<LegacyMarkdown source={source} isStreaming={isStreaming} />) })
    expect(live.innerHTML).toBe(baseline.innerHTML)
  }
})

it('renders two controller streams without lost deltas and flushes queued content on stop/error', async () => {
  vi.useFakeTimers()
  useWorkspaceStore.setState({ runs: {}, sessionNotifications: {} })
  const runtime = runtimeFixture()
  const controller = createSessionRunController({ runtime: runtime as never, invalidateHistory: async () => {} })
  controller.start({ sessionId: 'a', prompt: 'question' })
  controller.start({ sessionId: 'b', prompt: 'other question' })
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
  for (const sessionId of ['a', 'b']) runtime.emit(sessionId, { type: 'agent_start' })
  const answer = (id: string) => {
    const run = useWorkspaceStore.getState().runs[id]!
    return projectTurnPresentation(timelineItems(undefined, run.turns, []).at(-1)!, run.status === 'running').finalAnswer.map((part) => part.text).join('\n')
  }
  const show = async (id: string) => act(() => root.render(<AssistantMarkdown key={id} source={answer(id)} isStreaming={useWorkspaceStore.getState().runs[id]?.status === 'running'} />))
  for (const delta of ['# First\n\n', '```unknown\n', 'hello 😀\n', '```\n\none\n\ntwo\n\nthree']) {
    for (const id of ['a', 'b']) runtime.emit(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
    await act(() => vi.advanceTimersByTimeAsync(32))
    await show('a')
  }
  const pre = live.querySelector('pre')!
  for (const id of ['a', 'b']) runtime.emit(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '\n\nfinal' } })
  await controller.stop('a')
  runtime.emit('a', { type: 'agent_settled', aborted: true })
  runtime.emit('b', { type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })
  runtime.emit('b', { type: 'agent_settled' })
  await show('a')
  expect(live.querySelector('pre')).toBe(pre)
  expect(answer('a')).toBe(answer('b'))
  expect(answer('a')).toContain('three\n\nfinal')
  expect(useWorkspaceStore.getState().runs.a?.status).toBe('aborted')
  expect(useWorkspaceStore.getState().runs.b?.status).toBe('error')
  await show('b')
  expect(live.textContent).toContain('hello 😀')
})

it('keeps the answer code block mounted when persisted history takes over runtime events', async () => {
  const timestamp = '2026-10-18T00:00:00.000Z'
  const source = '```unknown\n  retained code\n```'
  const turn: RuntimeTurn = { id: 'pending', prompt: 'question', startedAt: timestamp, events: [
    { sessionId: 'a', sequence: 1, observedAt: timestamp, event: { type: 'message_start', message: { role: 'user', id: 'user', content: 'question' } } },
    { sessionId: 'a', sequence: 2, observedAt: timestamp, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: source } } },
  ] }
  await act(() => root.render(<SessionTimeline turns={[turn]} history={undefined} error={false} isLoading={false} isRunning onRetry={() => {}} overlayRoot={null} />))
  const pre = live.querySelector('pre.markdown-code')!
  const wrap = live.querySelector<HTMLButtonElement>('[aria-label="自动换行"]')!
  await act(() => wrap.click())
  const entries = [
    { id: 'user', parentId: null, type: 'message', timestamp, raw: { type: 'message', message: { role: 'user', content: 'question' } } },
    { id: 'answer', parentId: 'user', type: 'message', timestamp, raw: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: source }], stopReason: 'stop' } } },
  ]
  await act(() => root.render(<SessionTimeline turns={[{ ...turn, completedAt: timestamp }]} history={{ session: { id: 'a' }, entries, revision: 'new', hasEarlier: false }} error={false} isLoading={false} onRetry={() => {}} overlayRoot={null} />))
  expect(live.querySelector('pre.markdown-code')).toBe(pre)
  expect(wrap.getAttribute('aria-pressed')).toBe('true')
})
