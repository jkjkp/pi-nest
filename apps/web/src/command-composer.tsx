import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import type { SessionRunController } from './session-run-controller.js'
import { commandToken, completeCommand, matchingCommands } from './composer-commands.js'

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'ref'> & {
  value: string
  onValueChange: (value: string) => void
  onExecuteCommand: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  sessionId: string
  canQuery: boolean
  sessionRuns: SessionRunController
}

export function CommandComposer({ value, onValueChange, onExecuteCommand, textareaRef, sessionId, canQuery, sessionRuns, onKeyDown, onFocus, ...props }: Props) {
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | undefined>(undefined)
  const [selection, setSelection] = useState({ value: '', start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const token = focused && !composing && !dismissed && sessionId && selection.value === value
    ? commandToken(value, selection.start, selection.end) : undefined
  const open = Boolean(token)
  const commandsQuery = useQuery({
    queryKey: ['runtime-commands', sessionId],
    queryFn: () => sessionRuns.getCommands(sessionId),
    enabled: open && canQuery,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const commands = token ? matchingCommands(commandsQuery.data ?? [], token.query) : []
  const index = Math.min(highlight, Math.max(0, commands.length - 1))

  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, commands.length])
  useLayoutEffect(() => {
    if (pendingCaret.current === undefined) return
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = undefined
  }, [value, textareaRef])

  function updateSelection(input: HTMLTextAreaElement) {
    if (selection.value === input.value && selection.start === input.selectionStart && selection.end === input.selectionEnd) return
    setSelection({ value: input.value, start: input.selectionStart, end: input.selectionEnd })
    setHighlight(0)
    setDismissed(false)
  }

  function choose(name: string, enter = false) {
    if (!token) return
    const next = completeCommand(value, token, name)
    pendingCaret.current = next.caret
    setDismissed(true)
    onValueChange(next.value)
    textareaRef.current?.focus()
    if (enter && ['clone', 'compact', 'rename'].includes(name) && next.value.trim() === `/${name}`) onExecuteCommand(next.value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (open && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (commands.length) setHighlight((index + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && commands[index]) {
        event.preventDefault()
        choose(commands[index]!.name, event.key === 'Enter')
        return
      }
    }
    onKeyDown?.(event)
  }

  return <div className="relative w-full min-w-0" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    {open && <div className="absolute inset-x-0 bottom-full z-30 mb-3 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md" aria-label="命令提示">
      <div id={listId} ref={list} role="listbox" aria-label="可用命令" className="max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain p-1.5">
        {commands.map((command, itemIndex) => <button key={command.name} id={`${listId}-${itemIndex}`} type="button" role="option" aria-selected={itemIndex === index} tabIndex={-1} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${itemIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(command.name)}>
          <span className="shrink-0 font-normal">/{command.name}</span><span className="min-w-0 truncate text-muted-foreground">{command.description}</span>
        </button>)}
        {!commands.length && commandsQuery.data !== undefined && !commandsQuery.isFetching && !commandsQuery.isError && <p className="px-3 py-2 text-sm text-muted-foreground">没有匹配的命令</p>}
      </div>
      {commandsQuery.isFetching ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">正在读取命令…</p>
        : commandsQuery.isError ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-xs">命令列表加载失败<Button type="button" size="sm" variant="ghost" disabled={!canQuery} onMouseDown={(event) => event.preventDefault()} onClick={() => void commandsQuery.refetch()}>重试</Button></div>
          : !canQuery && !commandsQuery.data && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">会话空闲且运行时就绪后可读取更多命令</p>}
    </div>}
    <Textarea {...props} value={value} ref={textareaRef} aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-haspopup="listbox" aria-activedescendant={open && commands[index] ? `${listId}-${index}` : undefined}
      onChange={(event) => { updateSelection(event.currentTarget); onValueChange(event.target.value) }}
      onSelect={(event) => updateSelection(event.currentTarget)}
      onFocus={(event) => { setFocused(true); updateSelection(event.currentTarget); onFocus?.(event) }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); updateSelection(event.currentTarget) }}
      onKeyDown={handleKeyDown}
    />
  </div>
}
