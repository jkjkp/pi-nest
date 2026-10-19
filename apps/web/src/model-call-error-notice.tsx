import { modelCallErrorLabel, type ModelCallError } from './model-call-error.js'

export function ModelCallErrorNotice({ error }: { error: ModelCallError }) {
  return <section role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
    <p className="text-destructive">{modelCallErrorLabel(error)}</p>
    <details className="mt-2 text-muted-foreground"><summary className="cursor-pointer">查看详情</summary>
      <p className="mt-2 break-all">{[error.provider, error.model].filter(Boolean).join('/')}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{error.message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')}</p>
    </details>
  </section>
}
