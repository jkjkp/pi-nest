import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SessionNavigation } from './session-navigation.js'

const project = {
  cwd: '/work/pi-nest',
  key: 'cwd:/work/pi-nest',
  name: 'pi-nest',
  sessions: [{ firstMessage: '已有会话', id: 'session-1', updatedAt: '2026-09-24T00:00:00.000Z' }],
}

describe('SessionNavigation project actions', () => {
  it('reserves a hover-only action area without changing the project row width', () => {
    const markup = renderToStaticMarkup(
      <SessionNavigation
        collapsedProjectKeys={{}}
        error={null}
        isLoading={false}
        mutationSessionId={undefined}
        onClone={vi.fn(async () => {})} onDelete={async () => undefined}
        onNewConversation={vi.fn()}
        onAddProject={vi.fn()}
        onProjectOrderChange={vi.fn()}
        onRemoveProject={vi.fn()}
        onRename={async () => undefined}
        onRevealProject={async () => undefined}
        onSelect={vi.fn()}
        onSessionOrderChange={vi.fn()}
        onToggleProject={vi.fn()}
        projects={[project]}
        runs={{}}
        selectedSessionId="session-1"
      />,
    )

    expect(markup).toContain('w-[4.5rem]')
    expect(markup).toContain('pi-nest 更多操作')
    expect(markup).toContain('在 pi-nest 新建对话')
    expect(markup).toContain('创建项目')
    expect(markup).not.toContain('已移除项目')
    expect(markup).not.toContain('font-mono text-xs font-normal tabular-nums')
  })
})
