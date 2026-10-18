import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AssistantMarkdown, markdownComponents } from '../src/assistant-markdown.js'
import { LegacyMarkdown } from './legacy-markdown.js'
import { IncrementalMarkdownParser } from '../src/markdown-incremental.js'
import { parseMarkdown, renderMarkdown } from '../src/markdown-pipeline.js'
import { createSessionRunController } from '../src/session-run-controller.js'
import { useWorkspaceStore } from '../src/workspace-store.js'
import { timelineItems } from '../src/timeline-model.js'
import { projectTurnPresentation } from '../src/turn-execution-model.js'
import { SessionTimeline } from '../src/session-timeline.js'
import { streamingFixtures, prefixes } from './markdown-fixtures.js'
import { runtimeFixture } from './runtime-fixture.js'
import { workspaceSmoke } from './workspace-smoke.js'
import './style.css'

const root = createRoot(document.getElementById('content')!)
const viewport = document.getElementById('viewport')!
const report = document.getElementById('report')!
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values: number[], p = 0.95) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0
const round = (value: number) => Math.round(value * 100) / 100
const stats = (values: number[]) => ({ total: round(values.reduce((a, b) => a + b, 0)), p95: round(percentile(values)), max: round(Math.max(0, ...values)) })

async function grammarBenchmark() {
  const results = []
  for (const [name, source] of Object.entries(streamingFixtures())) {
    for (const mode of ['full', 'incremental']) {
      let units = 0, calls = 0
      const durations: number[] = []
      const parse = (text: string) => { units += text.length; calls++; return parseMarkdown(text) }
      const parser = new IncrementalMarkdownParser(parse)
      for (const text of prefixes(source, 256)) {
        const start = performance.now()
        if (mode === 'full') parse(text)
        else parser.update(text)
        durations.push(performance.now() - start)
      }
      const start = performance.now()
      renderMarkdown(parseMarkdown(source), markdownComponents, false)
      results.push({ name, mode, characters: source.length, grammarUnits: units, calls, parseMs: stats(durations), fullParseAndConvertMs: round(performance.now() - start) })
      await frame()
    }
  }
  return results
}

async function rendererBenchmark() {
  const results = []
  for (const size of [50_000, 100_000]) {
    for (const [name, source] of Object.entries(streamingFixtures(size))) {
      if (size === 100_000 && !['mixed', 'fence'].includes(name)) continue
      for (const mode of ['legacy', 'incremental']) {
        const sampleStart = performance.now()
        const Component = mode === 'legacy' ? LegacyMarkdown : AssistantMarkdown
        flushSync(() => root.render(null))
        // Keep cold grammar/module startup outside the steady-stream measurements.
        flushSync(() => root.render(<Component source={source.slice(0, 512)} isStreaming />))
        const updates: number[] = [], layout: number[] = [], feedback: number[] = []
        for (const [index, text] of prefixes(source, 512).entries()) {
          const start = performance.now()
          flushSync(() => root.render(<Component source={text} isStreaming />))
          updates.push(performance.now() - start)
          const beforeLayout = performance.now()
          void viewport.scrollHeight
          layout.push(performance.now() - beforeLayout)
          if (index % 10 === 0) {
            const beforeFeedback = performance.now()
            document.getElementById('draft')!.dispatchEvent(new Event('input', { bubbles: true }))
            await frame()
            feedback.push(performance.now() - beforeFeedback)
          } else await frame()
        }
        const start = performance.now()
        flushSync(() => root.render(<Component source={source} isStreaming={false} />))
        const settleCommitMs = round(performance.now() - start)
        const settleEnd = performance.now()
        // Include the existing asynchronous highlighting effects in Long Task attribution.
        await wait(150)
        await frame()
        results.push({ name, mode, characters: source.length, commitMs: stats(updates), layoutMs: stats(layout), syntheticInputToRafMs: stats(feedback), settleCommitMs, settleEnd, sampleStart, sampleEnd: performance.now() })
        report.textContent = JSON.stringify({ stage: 'renderer', last: results.at(-1) }, null, 2)
      }
    }
  }
  return results
}

async function runtimeBenchmark() {
  const results = []
  for (const mode of ['legacy', 'incremental']) {
    const Component = mode === 'legacy' ? LegacyMarkdown : AssistantMarkdown
    useWorkspaceStore.setState({ runs: {}, sessionNotifications: {} })
    const runtime = runtimeFixture()
    const controller = createSessionRunController({ runtime: runtime as never, invalidateHistory: async () => {} })
    controller.start({ sessionId: 'perf-a', prompt: 'synthetic replay' })
    controller.start({ sessionId: 'perf-b', prompt: 'background replay' })
    await wait(0)
    const emit = runtime.emit
    for (const sessionId of ['perf-a', 'perf-b']) emit(sessionId, { type: 'agent_start' })
    const source = streamingFixtures(50_000).mixed
    const projection: number[] = [], commits: number[] = [], batches: number[] = [], postFlush: number[] = [], eventToVisible: number[] = []
    let batchStart = 0, batchEnd = 0
    const unsubscribe = useWorkspaceStore.subscribe(() => { const time = performance.now(); batchStart ||= time; batchEnd = time })
    flushSync(() => root.render(null))
    for (let start = 0; start < source.length; start += 512) {
      batchStart = 0
      const emittedAt = performance.now()
      for (const sessionId of ['perf-a', 'perf-b']) for (let chunk = start; chunk < Math.min(start + 512, source.length); chunk += 128) emit(sessionId, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: source.slice(chunk, Math.min(chunk + 128, start + 512, source.length)) } })
      await wait(34)
      batches.push(batchEnd - batchStart)
      const before = performance.now()
      const run = useWorkspaceStore.getState().runs['perf-a']!
      const items = timelineItems(undefined, run.turns, [])
      const answer = projectTurnPresentation(items.at(-1)!, true).finalAnswer.map((part) => part.text).join('\n')
      projection.push(performance.now() - before)
      const renderStart = performance.now()
      flushSync(() => root.render(<Component source={answer} isStreaming />))
      commits.push(performance.now() - renderStart)
      await frame()
      postFlush.push(performance.now() - batchEnd)
      eventToVisible.push(performance.now() - emittedAt)
    }
    for (const sessionId of ['perf-a', 'perf-b']) emit(sessionId, { type: 'agent_settled' })
    unsubscribe()
    const run = useWorkspaceStore.getState().runs['perf-a']!
    if (projectTurnPresentation(timelineItems(undefined, run.turns, []).at(-1)!, false).finalAnswer.map((part) => part.text).join('\n') !== source) throw new Error('Replay lost content')
    // Mount the actual virtualized timeline as well as the isolated answer renderer.
    flushSync(() => root.render(<SessionTimeline turns={run.turns} history={undefined} error={false} isLoading={false} onRetry={() => {}} scrollViewport={viewport} overlayRoot={null} />))
    await frame()
    results.push({ mode, batchesMs: stats(batches), projectionMs: stats(projection), commitMs: stats(commits), postFlushToRafMs: stats(postFlush), eventToRafMs: stats(eventToVisible), aStatus: run.status, bStatus: useWorkspaceStore.getState().runs['perf-b']?.status, actualTimelineMounted: Boolean(viewport.querySelector('[data-turn-id]')) })
  }
  return results
}

async function run() {
  const button = document.getElementById('run') as HTMLButtonElement
  button.disabled = true
  const longTasks: { start: number; duration: number }[] = []
  const observer = new PerformanceObserver((entries) => { for (const entry of entries.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration }) })
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({ type: 'longtask' })
  try {
    const grammar = await grammarBenchmark()
    const rendererStart = performance.now()
    const renderer = await rendererBenchmark()
    const runtime = await runtimeBenchmark()
    await wait(100)
    const result = { environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, viewport: [innerWidth, innerHeight], mode: import.meta.env.MODE }, grammar, renderer, runtime, rendererLongTasks: longTasks.filter((task) => task.start >= rendererStart) }
    report.textContent = JSON.stringify(result, null, 2)
    return result
  } finally { observer.disconnect(); button.disabled = false }
}

async function retentionProbe() {
  const source = streamingFixtures(8_000).mixed
  for (let message = 0; message < 30; message++) {
    flushSync(() => root.render(null))
    for (const text of prefixes(source, 512)) flushSync(() => root.render(<AssistantMarkdown source={text} isStreaming />))
  }
  flushSync(() => root.render(null))
  // Replace both React fiber alternates before collecting, rather than retaining the last unmounted tree.
  flushSync(() => root.render(<span />))
  flushSync(() => root.render(null))
  await frame()
}

document.getElementById('run')!.addEventListener('click', () => { void run().catch((error) => { report.textContent = String(error) }) })
Object.assign(window, {
  runMarkdownBenchmark: run,
  runMarkdownRuntimeBenchmark: runtimeBenchmark,
  runMarkdownRetentionProbe: retentionProbe,
  markdownParserPrototype: IncrementalMarkdownParser.prototype,
  mountWorkspaceSmoke: async () => {
    const smoke = workspaceSmoke()
    viewport.style.cssText = 'position:fixed;inset:0;z-index:100;background:var(--background)'
    flushSync(() => root.render(smoke.element))
    await smoke.start()
    return Object.assign(window, { workspaceSmoke: smoke }).workspaceSmoke !== undefined
  },
})
