import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PiSessionHistoryResponse } from '@pi-nest/contracts'
import type { RuntimeTurn } from './session-run-model.js'
import type { TurnJumpAlignment } from './timeline-pagination.js'
import { shouldFollowLatest } from './workspace.js'

type TimelineViewportOptions = {
  selectedSessionId: string
  history: PiSessionHistoryResponse | undefined
  activeTurn: RuntimeTurn | undefined
  isActive: boolean
  inspectorOpen: boolean
  setInspectorOpen: (open: boolean) => void
}

export function useTimelineViewport({ selectedSessionId, history, activeTurn, isActive, inspectorOpen, setInspectorOpen }: TimelineViewportOptions) {
  const [followLatest, setFollowLatest] = useState(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [railOverlay, setRailOverlay] = useState<HTMLElement | null>(null)
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(null)
  const [composer, setComposer] = useState<HTMLDivElement | null>(null)
  const messageScrollAreaRef = useRef<HTMLDivElement>(null)
  const navigationInProgress = useRef(false)
  const returningToBottom = useRef(false)
  const navigationFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const followLatestRef = useRef(followLatest)
  const showScrollToBottomRef = useRef(showScrollToBottom)
  const inspectorToggleScrollTop = useRef<number | undefined>(undefined)
  const positionedTurn = useRef<string | undefined>(undefined)
  const previouslyScrolledSessionId = useRef(selectedSessionId)
  const scrollFrame = useRef<number | undefined>(undefined)
  const scheduleScroll = useCallback((scroll: () => void) => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      scroll()
    })
  }, [])
  useLayoutEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = undefined
  }, [selectedSessionId, scrollViewport])
  const setFollowingLatest = useCallback((value: boolean) => {
    if (followLatestRef.current === value) return
    followLatestRef.current = value
    setFollowLatest(value)
  }, [])
  const setMessageScrollArea = useCallback((node: HTMLDivElement | null) => {
    messageScrollAreaRef.current = node
    setScrollViewport(node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null)
  }, [setScrollViewport])

  useLayoutEffect(() => {
    const pane = composer?.parentElement
    if (!composer || !pane) return
    const measure = () => pane.style.setProperty('--composer-height', `${composer.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(composer)
    return () => { observer.disconnect(); pane.style.removeProperty('--composer-height') }
  }, [composer])

  useEffect(() => {
    const messages = messageScrollAreaRef.current
    if (!messages || !composer) return
    const blockHiddenInteraction = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !scrollViewport?.contains(event.target)) return
      if (event.clientY < composer.getBoundingClientRect().top) return
      event.preventDefault()
      event.stopPropagation()
    }
    const events = ['pointerdown', 'click', 'dblclick', 'contextmenu'] as const
    for (const type of events) messages.addEventListener(type, blockHiddenInteraction, true)
    return () => { for (const type of events) messages.removeEventListener(type, blockHiddenInteraction, true) }
  }, [composer, scrollViewport])

  const setRailOverlayRoot = useCallback((node: HTMLDivElement | null) => setRailOverlay(node), [setRailOverlay])

  const scrollToFinalAnswer = useCallback((turnId: string) => {
    if (!followLatestRef.current || !scrollViewport) return
    scheduleScroll(() => {
      if (!followLatestRef.current) return
      const answer = [...(messageScrollAreaRef.current?.querySelectorAll<HTMLElement>('[data-final-answer-turn-id]') ?? [])].find((element) => element.dataset.finalAnswerTurnId === turnId)
      if (!answer) return
      const offset = answer.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top
      scrollViewport.scrollTo({ top: Math.max(0, scrollViewport.scrollTop + offset - 48) })
    })
  }, [scrollViewport, scheduleScroll])

  const followFinalAnswer = useCallback(() => {
    if (!followLatestRef.current || !scrollViewport) return
    scheduleScroll(() => {
      if (!followLatestRef.current || navigationInProgress.current) return
      const bottom = Math.max(0, scrollViewport.scrollHeight - scrollViewport.clientHeight)
      if (Math.abs(scrollViewport.scrollTop - bottom) > 1) scrollViewport.scrollTop = bottom
    })
  }, [scrollViewport, scheduleScroll])

  useEffect(() => {
    if (!scrollViewport) return
    let previousScrollHeight = scrollViewport.scrollHeight
    let previousViewportHeight = scrollViewport.clientHeight
    const updateFollowLatest = () => {
      const resized = previousScrollHeight !== scrollViewport.scrollHeight || previousViewportHeight !== scrollViewport.clientHeight
      previousScrollHeight = scrollViewport.scrollHeight
      previousViewportHeight = scrollViewport.clientHeight
      // Measure here; defer writes so scroll and resize callbacks cannot feed each other.
      if (resized && followLatestRef.current && !navigationInProgress.current) {
        followFinalAnswer()
        return
      }
      const next = shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, navigationInProgress.current)
      const show = !shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, false)
      if (showScrollToBottomRef.current !== show) {
        showScrollToBottomRef.current = show
        setShowScrollToBottom(show)
      }
      setFollowingLatest(next)
    }
    const completeNavigation = () => {
      clearTimeout(navigationFallback.current)
      navigationFallback.current = undefined
      navigationInProgress.current = false
      returningToBottom.current = false
      updateFollowLatest()
    }
    const handleScroll = () => {
      updateFollowLatest()
      if (!navigationInProgress.current) return
      clearTimeout(navigationFallback.current)
      navigationFallback.current = setTimeout(completeNavigation, 150)
    }
    const interruptNavigation = (event: Event) => {
      if (!returningToBottom.current) return
      if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
      clearTimeout(navigationFallback.current)
      navigationInProgress.current = false
      returningToBottom.current = false
      setFollowingLatest(false)
      scrollViewport.scrollTo({ top: scrollViewport.scrollTop, behavior: 'instant' })
    }
    const observer = new ResizeObserver(() => {
      if (returningToBottom.current) scheduleScroll(() => scrollViewport.scrollTo({ top: scrollViewport.scrollHeight, behavior: 'smooth' }))
      updateFollowLatest()
    })
    observer.observe(scrollViewport)
    if (scrollViewport.firstElementChild) observer.observe(scrollViewport.firstElementChild)
    scrollViewport.addEventListener('wheel', interruptNavigation, { passive: true })
    scrollViewport.addEventListener('touchstart', interruptNavigation, { passive: true })
    scrollViewport.addEventListener('pointerdown', interruptNavigation)
    scrollViewport.addEventListener('keydown', interruptNavigation)
    scrollViewport.addEventListener('scroll', handleScroll, { passive: true })
    scrollViewport.addEventListener('scrollend', completeNavigation)
    return () => {
      clearTimeout(navigationFallback.current)
      observer.disconnect()
      scrollViewport.removeEventListener('wheel', interruptNavigation)
      scrollViewport.removeEventListener('touchstart', interruptNavigation)
      scrollViewport.removeEventListener('pointerdown', interruptNavigation)
      scrollViewport.removeEventListener('keydown', interruptNavigation)
      scrollViewport.removeEventListener('scroll', handleScroll)
      scrollViewport.removeEventListener('scrollend', completeNavigation)
    }
  }, [scrollViewport, setFollowingLatest, followFinalAnswer, scheduleScroll])

  useLayoutEffect(() => {
    const selectedSessionChanged = previouslyScrolledSessionId.current !== selectedSessionId
    previouslyScrolledSessionId.current = selectedSessionId
    if (selectedSessionChanged) {
      clearTimeout(navigationFallback.current)
      navigationInProgress.current = false
      returningToBottom.current = false
      inspectorToggleScrollTop.current = undefined
    }
    if (navigationInProgress.current || (!followLatest && !selectedSessionChanged)) return
    scheduleScroll(() => {
      if (!navigationInProgress.current && scrollViewport) scrollViewport.scrollTop = scrollViewport.scrollHeight
    })

  }, [followLatest, history, scrollViewport, selectedSessionId, scheduleScroll])

  useLayoutEffect(() => {
    const key = activeTurn ? `${selectedSessionId}:${activeTurn.startedAt}` : undefined
    if (!isActive || !key || !scrollViewport || positionedTurn.current === key) return
    positionedTurn.current = key
    scheduleScroll(() => { scrollViewport.scrollTop = scrollViewport.scrollHeight })
  }, [activeTurn, isActive, scrollViewport, selectedSessionId, scheduleScroll])

  useLayoutEffect(() => {
    if (inspectorToggleScrollTop.current === undefined || !scrollViewport) return
    scrollViewport.scrollTo({ top: inspectorToggleScrollTop.current })
    inspectorToggleScrollTop.current = undefined
  }, [inspectorOpen, scrollViewport])

  function toggleInspector() {
    inspectorToggleScrollTop.current = scrollViewport?.scrollTop
    setInspectorOpen(!inspectorOpen)
  }

  const scrollToBottom = useCallback(() => {
    if (!scrollViewport) return
    clearTimeout(navigationFallback.current)
    inspectorToggleScrollTop.current = undefined
    setFollowingLatest(false)
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    navigationInProgress.current = behavior === 'smooth'
    returningToBottom.current = behavior === 'smooth'
    scrollViewport.scrollTo({ top: scrollViewport.scrollHeight, behavior })
    if (behavior === 'auto') setFollowingLatest(true)
  }, [scrollViewport, setFollowingLatest])

  const jumpToTurn = useCallback((_turnId: string, scrollTo: (behavior: ScrollBehavior) => void, alignment: TurnJumpAlignment) => {
    if (!scrollViewport) return
    returningToBottom.current = false
    clearTimeout(navigationFallback.current)
    setFollowingLatest(false)
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    navigationInProgress.current = behavior === 'smooth'
    scrollTo(behavior)
    if (alignment === 'end') requestAnimationFrame(() => scrollViewport.scrollTo({ behavior, top: scrollViewport.scrollHeight }))
  }, [scrollViewport, setFollowingLatest])

  return { setComposer, showScrollToBottom, scrollToBottom, followLatest, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot, scrollToFinalAnswer, followFinalAnswer, jumpToTurn, toggleInspector }
}
