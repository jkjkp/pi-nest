import { beforeEach, expect, it } from 'vitest'
import { filePreviewKey, isPreviewImage, localMarkdownLink } from './file-preview-state.js'
import { useWorkspaceStore } from './workspace-store.js'

beforeEach(() => useWorkspaceStore.setState({ filePreviews: {}, fileReadingPositions: {} }))
it('isolates selections by session, remembers collapsed files and keeps file state out of persistence', () => {
  const state = useWorkspaceStore.getState()
  state.openFilePreview('one', 'src/a.ts', 80)
  state.setFilePreviewOpen('one', false)
  state.openFilePreview('two', 'README.md')
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ path: 'src/a.ts', line: 80, open: false })
  state.setFilePreviewOpen('one', true)
  state.openFilePreview('one', 'src/a.ts', 90)
  expect(useWorkspaceStore.getState().filePreviews.one).toMatchObject({ line: 90, open: true, navigation: 2 })
  const key = filePreviewKey('one', 'src/a.ts')
  state.rememberFilePosition(key, { start: 40, scrollTop: 10, scrollLeft: 0, mode: 'source', zoom: 'fit' })
  const persisted = useWorkspaceStore.persist.getOptions().partialize!(useWorkspaceStore.getState())
  expect(persisted).not.toHaveProperty('filePreviews')
  expect(persisted).not.toHaveProperty('fileReadingPositions')
  state.clearFilePreview('one')
  expect(useWorkspaceStore.getState().filePreviews).toEqual({ two: expect.objectContaining({ path: 'README.md' }) })
  expect(useWorkspaceStore.getState().fileReadingPositions).toEqual({})
})
it('resolves document-relative file links and line fragments without swallowing traversal', () => {
  expect(localMarkdownLink('docs/guide.md', '../src/a%20b.ts#L24-L30')).toEqual({ path: 'docs/../src/a b.ts', line: 24 })
  expect(localMarkdownLink('README.md', '../../outside')).toEqual({ path: '../../outside', line: undefined })
  expect(localMarkdownLink('README.md', '/project/a.ts#L5')).toEqual({ path: '/project/a.ts', line: 5 })
  for (const href of ['https://example.com', '//example.com', 'javascript:alert(1)', 'data:text/html,test', '#heading', '%', 'a%00b', 'a\\b']) expect(localMarkdownLink('docs/a.md', href)).toBeUndefined()
  expect(isPreviewImage('screenshot.JPEG')).toBe(true)
  expect(isPreviewImage('drawing.svg')).toBe(false)
})
