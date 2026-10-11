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
  const [railOverlay, setRailOverlay] = useState<HTMLElement | null>(null)
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(null)
  const messageScrollAreaRef = useRef<HTMLDivElement>(null)
  const navigationInProgress = useRef(false)
  const navigationFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const followLatestRef = useRef(followLatest)
  const inspectorToggleScrollTop = useRef<number | undefined>(undefined)
  const positionedTurn = useRef<string | undefined>(undefined)
  const previouslyScrolledSessionId = useRef(selectedSessionId)
  const setFollowingLatest = useCallback((value: boolean) => {
    followLatestRef.current = value
    setFollowLatest(value)
  }, [])
  const setMessageScrollArea = useCallback((node: HTMLDivElement | null) => {
    messageScrollAreaRef.current = node
    setScrollViewport(node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null)
  }, [setScrollViewport])

  const setRailOverlayRoot = useCallback((node: HTMLDivElement | null) => setRailOverlay(node), [setRailOverlay])

  const scrollToFinalAnswer = useCallback((turnId: string) => {
    if (!followLatestRef.current || !scrollViewport) return
    requestAnimationFrame(() => {
      if (!followLatestRef.current) return
      const answer = [...(messageScrollAreaRef.current?.querySelectorAll<HTMLElement>('[data-final-answer-turn-id]') ?? [])].find((element) => element.dataset.finalAnswerTurnId === turnId)
      if (!answer) return
      const offset = answer.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top
      scrollViewport.scrollTo({ top: Math.max(0, scrollViewport.scrollTop + offset - 48) })
    })
  }, [scrollViewport])

  const followFinalAnswer = useCallback(() => {
    if (!followLatestRef.current || !scrollViewport) return
    requestAnimationFrame(() => {
      if (followLatestRef.current) scrollViewport.scrollTop = scrollViewport.scrollHeight
    })
  }, [scrollViewport])

  useEffect(() => {
    if (!scrollViewport) return
    const updateFollowLatest = () => {
      const next = shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, navigationInProgress.current)
      setFollowingLatest(next)
    }
    const completeNavigation = () => {
      clearTimeout(navigationFallback.current)
      navigationFallback.current = undefined
      navigationInProgress.current = false
      updateFollowLatest()
    }
    const handleScroll = () => {
      updateFollowLatest()
      if (!navigationInProgress.current) return
      clearTimeout(navigationFallback.current)
      navigationFallback.current = setTimeout(completeNavigation, 150)
    }
    scrollViewport.addEventListener('scroll', handleScroll, { passive: true })
    scrollViewport.addEventListener('scrollend', completeNavigation)
    return () => {
      clearTimeout(navigationFallback.current)
      scrollViewport.removeEventListener('scroll', handleScroll)
      scrollViewport.removeEventListener('scrollend', completeNavigation)
    }
  }, [scrollViewport, setFollowingLatest])

  useLayoutEffect(() => {
    const selectedSessionChanged = previouslyScrolledSessionId.current !== selectedSessionId
    previouslyScrolledSessionId.current = selectedSessionId
    if (!followLatest && !selectedSessionChanged) return
    const frame = requestAnimationFrame(() => {
      if (scrollViewport) scrollViewport.scrollTop = scrollViewport.scrollHeight
    })

    return () => cancelAnimationFrame(frame)
  }, [followLatest, history, scrollViewport, selectedSessionId])

  useLayoutEffect(() => {
    const key = activeTurn ? `${selectedSessionId}:${activeTurn.startedAt}` : undefined
    if (!isActive || !key || !scrollViewport || positionedTurn.current === key) return
    positionedTurn.current = key
    const frame = requestAnimationFrame(() => { scrollViewport.scrollTop = scrollViewport.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [activeTurn, isActive, scrollViewport, selectedSessionId])

  useLayoutEffect(() => {
    if (inspectorToggleScrollTop.current === undefined || !scrollViewport) return
    scrollViewport.scrollTo({ top: inspectorToggleScrollTop.current })
    inspectorToggleScrollTop.current = undefined
  }, [inspectorOpen, scrollViewport])

  function toggleInspector() {
    inspectorToggleScrollTop.current = scrollViewport?.scrollTop
    setInspectorOpen(!inspectorOpen)
  }

  const jumpToTurn = useCallback((_turnId: string, scrollTo: (behavior: ScrollBehavior) => void, alignment: TurnJumpAlignment) => {
    if (!scrollViewport) return
    setFollowingLatest(false)
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    if (behavior === 'smooth') navigationInProgress.current = true
    scrollTo(behavior)
    if (alignment === 'end') requestAnimationFrame(() => scrollViewport.scrollTo({ behavior, top: scrollViewport.scrollHeight }))
  }, [scrollViewport, setFollowingLatest])

  return { followLatest, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot, scrollToFinalAnswer, followFinalAnswer, jumpToTurn, toggleInspector }
}
