import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, it } from 'vitest'
import { SettingsPage } from './settings-page.js'
import { changedSettings, settingsCategories } from './settings-model.js'
it('renders all six categories in the settings layout without requiring a session', () => {
  const router = createMemoryRouter([{ path: '/settings/:category?', element: <SettingsPage /> }], { initialEntries: ['/settings/mcp'] })
  const html = renderToStaticMarkup(<RouterProvider router={router} />)
  for (const category of settingsCategories) expect(html).toContain(category.label)
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('md:grid-cols-[220px_minmax(0,1fr)]')
  expect(html).toContain('正在读取 Pi 配置')
  expect(html).not.toContain('请选择一个 Pi 会话')
})
it('only submits changed fields so effective project values do not leak into global settings', () => {
  expect(changedSettings({ defaultModel: 'global', retryEnabled: true }, { defaultModel: 'global', retryEnabled: false })).toEqual({ retryEnabled: false })
  expect(changedSettings({ skills: ['one'] }, { skills: ['one'] })).toEqual({})
})
