# Streaming Markdown replay

From the workspace root:

```sh
pnpm --filter @pi-nest/web perf:markdown
```

Open the printed localhost URL and click **运行前后对照**. This builds an isolated production page with the actual product CSS; it does not replace the default application build. The fixtures and transport are synthetic: no model calls, API requests or native session writes.

The page compares the frozen pre-change `legacy-markdown.tsx` with the current renderer, then sends interleaved A/B events through the real controller, store and timeline projection. Results include grammar input units (UTF-16), parsing, synchronous React commit, forced layout, completion, synthetic input-to-rAF and Long Tasks. The synthetic input metric is not real-user INP. The runtime replay retains the existing 32ms event buffer; post-flush-to-rAF is reported separately from event-to-rAF.

Developer-console entry points:

```js
await window.runMarkdownRuntimeBenchmark() // shorter controller replay
await window.mountWorkspaceSmoke()        // full workspace with cached fake history
window.workspaceSmoke.append('smoke-a', '\n\nnext paragraph')
window.workspaceSmoke.finish('smoke-a')
window.workspaceSmoke.publishHistory('smoke-a')
```

`runMarkdownRetentionProbe()` repeatedly mounts, streams and releases 30 messages. In an isolated browser, CDP `HeapProfiler.collectGarbage` plus `Runtime.queryObjects` for `window.markdownParserPrototype` can check retained parser instances. Release the query result handles between probes. This tests parser-instance retention, not total application heap usage.

See `results-2026-10-18.json` for the measured environment and results. Large single lists/tables and reference-definition documents intentionally retain full-tail/full-document parsing and still produce long tasks. Wall-clock thresholds are not CI assertions; the tests assert grammar input reduction, prefix parity, DOM identity, lifecycle and safety behavior.
