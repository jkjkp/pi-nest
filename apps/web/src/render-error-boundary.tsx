import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

export class RenderErrorBoundary extends Component<{
  children: ReactNode
  scope: 'turn' | 'timeline'
  sessionId?: string
  turnId?: string
}, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Conversation render failed', {
      name: error.name, hookOrder: /Rendered (fewer|more) hooks|order of Hooks/.test(error.message),
      componentStack: info.componentStack, sessionId: this.props.sessionId, turnId: this.props.turnId,
    })
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <section role="alert" className="rounded-xl border border-destructive/30 bg-background p-4 text-sm">
      <p>{this.props.scope === 'turn' ? '这一轮内容暂时无法显示。' : '对话内容暂时无法显示。'}</p>
      <p className="mt-1 text-xs text-muted-foreground">显示异常不会停止任务，也不会重新发送消息。</p>
      <Button className="mt-3" size="sm" variant="outline" type="button" onClick={() => this.setState({ failed: false })}>重新加载显示</Button>
    </section>
  }
}
