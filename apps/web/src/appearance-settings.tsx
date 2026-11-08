import { useState } from 'react'
import { Select } from '@/components/ui/select'
import { bodyFontSizes } from './typography.js'
import { useWorkspaceStore } from './workspace-store.js'

export function AppearanceSettings() {
  const fontSize = useWorkspaceStore((state) => state.bodyFontSize)
  const setFontSize = useWorkspaceStore((state) => state.setBodyFontSize)
  const [error, setError] = useState<string>()
  return <section className="space-y-3 rounded-xl border p-5">
    <div className="grid gap-2">
      <span className="text-sm">正文字号</span>
      <Select label="正文字号" value={String(fontSize)} options={bodyFontSizes.map((size) => ({ value: String(size), label: `${size} px${size === 15 ? '（默认）' : ''}` }))} onValueChange={(value) => {
        setError(undefined)
        try { setFontSize(Number(value)) }
        catch { setError('字号已应用，但无法保存到当前浏览器。请检查浏览器存储设置。') }
      }} />
      <p className="text-xs text-muted-foreground">其他文字随之调整。</p>
    </div>
    <p className="text-xs text-muted-foreground">立即生效，自动保存在当前浏览器，对所有项目和会话有效。</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
