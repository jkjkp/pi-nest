import { beforeEach, expect, it } from 'vitest'
import { restoreFilePanels, restoreFilePositions, filePreviewKey, isPreviewImage, localMarkdownLink } from './file-preview-state.js'
import { useWorkspaceStore } from './workspace-store.js'

beforeEach(() => useWorkspaceStore.setState({ filePreviews: {}, fileReadingPositions: {} }))
it('isolates selections by session, remembers collapsed files and persists only reading and navigation metadata', () => {
  const state = useWorkspaceStore.getState()
  state.openFilePreview('one', 'src/a.ts', 80)
  state.setFilePreviewOpen('one', false)
  state.openFilePreview('two', 'README.md')
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ tabs: [{ path: 'src/a.ts', line: 80 }], open: false })
  state.setFilePreviewOpen('one', true)
  state.openFilePreview('one', 'src/a.ts', 90)
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ tabs: [{ line: 90, navigation: 2 }], open: true })
  const key = filePreviewKey('one', 'src/a.ts')
  state.rememberFilePosition(key, { start: 40, scrollTop: 10, scrollLeft: 0, mode: 'source', zoom: 'fit' })
  const persisted = useWorkspaceStore.persist.getOptions().partialize!(useWorkspaceStore.getState())
  expect(persisted).toHaveProperty('filePreviews')
  expect(persisted).toHaveProperty('fileReadingPositions')
  state.clearFilePreview('one')
  expect(useWorkspaceStore.getState().filePreviews).toEqual({ two: expect.objectContaining({ tabs: [expect.objectContaining({ path: 'README.md' })] }) })
  expect(useWorkspaceStore.getState().fileReadingPositions).toEqual({})
})
it('resolves document-relative file links and line fragments without swallowing traversal', () => {
  expect(localMarkdownLink('docs/guide.md', '../src/a%20b.ts#L24-L30')).toEqual({ path: 'docs/../src/a b.ts', line: 24 })
  expect(localMarkdownLink('README.md', '../../outside')).toEqual({ path: '../../outside', line: undefined })
  expect(localMarkdownLink('README.md', '/project/a.ts#L5')).toEqual({ path: '/project/a.ts', line: 5 })
  expect(localMarkdownLink('/other/docs/guide.md', '../src/a%20b.ts#L24')).toEqual({ path: '/other/docs/../src/a b.ts', line: 24 })
  expect(localMarkdownLink('/other/next.md', 'last.md')).toEqual({ path: '/other/last.md', line: undefined })
  for (const href of ['https://example.com', '//example.com', 'javascript:alert(1)', 'data:text/html,test', '#heading', '%', 'a%00b', 'a\\b']) expect(localMarkdownLink('docs/a.md', href)).toBeUndefined()
  expect(isPreviewImage('screenshot.JPEG')).toBe(true)
  expect(isPreviewImage('drawing.svg')).toBe(false)
})


it('opens the project tree before a file, deduplicates tabs and returns to files on close', () => {
  const state = useWorkspaceStore.getState()
  state.setFilePreviewOpen('one', true)
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ open: true, tabs: [] })
  state.openFilePreview('one', 'a.ts', 1)
  state.openFilePreview('one', 'a.ts', 5)
  state.openFilePreview('one', 'b.ts')
  expect(useWorkspaceStore.getState().filePreviews.one?.tabs).toHaveLength(2)
  const key = useWorkspaceStore.getState().filePreviews.one!.activeTab!
  state.closeFileTab('one', key)
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ open: true, activeTab: undefined })
  state.transferFilePreview('one', 'created')
  expect(useWorkspaceStore.getState().filePreviews.one).toBeUndefined()
  expect(useWorkspaceStore.getState().filePreviews.created?.tabs).toHaveLength(1)
})

it('validates restored metadata and strips file content from persisted positions', () => {
  expect(restoreFilePanels({ old: { open: true, path: 'a' }, malformed: { open: true, tabs: null } })).toEqual({})
  const key = filePreviewKey('a', 'a.ts')
  expect(restoreFilePositions({ [key]: { start: 0, scrollTop: 1, scrollLeft: 0, mode: 'source', zoom: 'fit', content: 'must not persist' } })).toEqual({ [key]: { start: 0, scrollTop: 1, scrollLeft: 0, mode: 'source', zoom: 'fit' } })
})
