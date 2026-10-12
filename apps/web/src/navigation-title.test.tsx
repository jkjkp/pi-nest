import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { NavigationTitle } from './navigation-title.js'

it('preserves the full accessible title without ellipsis or an extra tab stop', () => {
  const title = '了解 Understand-Anything 的使用方法和完整项目导航设计'
  const markup = renderToStaticMarkup(<button><NavigationTitle>{title}</NavigationTitle></button>)
  expect(markup).toContain(title)
  expect(markup).toContain('navigation-title')
  expect(markup).toContain('inline-block w-max')
  expect(markup).not.toContain('truncate')
  expect(markup).not.toContain('tabindex')
})
