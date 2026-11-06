// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsPage } from './settings-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchPiConfiguration, savePiConfiguration } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchPiConfiguration: vi.fn().mockRejectedValue(new Error('Pi 配置不可用')), savePiConfiguration: vi.fn() }))
vi.mock('@/components/ui/select', () => ({ Select: ({ label, value, options, onValueChange }: { label: string; value: string; options: { value: string; label: string }[]; onValueChange: (value: string) => void }) => <select aria-label={label} value={value} onChange={(event) => onValueChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); useWorkspaceStore.setState({ bodyFontSize: 15 }) })

it('applies font changes immediately without Pi configuration or an unsaved prompt, and reports storage failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const router = createMemoryRouter([{ path: '/settings/:category?', element: <SettingsPage /> }], { initialEntries: ['/settings/appearance'] })
  try {
    await act(() => root.render(<RouterProvider router={router} />))
    expect(fetchPiConfiguration).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Pi Nest 外观')
    expect(container.textContent).toContain('其他文字随之调整。')
    expect(container.textContent).not.toContain('重新加载')
    const select = container.querySelector<HTMLSelectElement>('[aria-label="正文字号"]')!
    expect(select.value).toBe('15')
    expect([...select.options].map((option) => option.value)).toEqual(['14', '15', '16', '18', '20'])
    await act(() => { select.value = '20'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useWorkspaceStore.getState().bodyFontSize).toBe(20)
    expect(savePiConfiguration).not.toHaveBeenCalled()
    const setter = useWorkspaceStore.getState().setBodyFontSize
    await act(() => useWorkspaceStore.setState({ setBodyFontSize: (size) => { setter(size); throw new Error('QuotaExceededError') } }))
    try {
      await act(() => { select.value = '18'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(useWorkspaceStore.getState().bodyFontSize).toBe(18)
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法保存到当前浏览器')
    } finally { await act(() => useWorkspaceStore.setState({ setBodyFontSize: setter })) }
    await act(() => router.navigate('/settings/advanced'))
    expect(container.textContent).not.toContain('放弃未保存')
    expect(fetchPiConfiguration).toHaveBeenCalledOnce()
    await act(() => router.navigate('/settings/appearance'))
    expect(container.textContent).not.toContain('Pi 配置不可用')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="正文字号"]')!.value).toBe('18')
  } finally {
    await act(() => root.unmount())
    router.dispose()
    container.remove()
  }
})
