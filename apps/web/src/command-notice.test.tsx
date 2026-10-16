import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CommandNotice } from './command-notice.js'

it('shows command errors as a floating toast instead of inline text', () => {
  const markup = renderToStaticMarkup(<CommandNotice notice={{ message: 'Clone failed', error: true }} />)
  expect(markup).toContain('role="alert"')
  expect(markup).toContain('fixed top-5')
  expect(markup).toContain('Clone failed')
  expect(markup).not.toContain('<p')
  expect(renderToStaticMarkup(<CommandNotice />)).toBe('')
})

it('keeps progress and other command feedback inline', () => {
  const markup = renderToStaticMarkup(<CommandNotice notice={{ message: '正在执行 /clone…' }} />)
  expect(markup).toContain('<p role="status"')
  expect(markup).not.toContain('fixed')
})
