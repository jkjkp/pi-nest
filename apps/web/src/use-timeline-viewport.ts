import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PiSessionHistoryResponse } from '@pi-nest/contracts'
import type { RuntimeTurn } from './session-run-model.js'
import type { TimelineReadingPosition, TimelineScrollController, TurnJumpAlignment } from './timeline-pagination.js'
import { shouldFollowLatest } from './workspace.js'

type TimelineViewportOptions = {
  selectedSessionId: string
  history: PiSessionHistoryResponse | undefined
  activeTurn: RuntimeTurn | undefined
  latestSteeringId?: string
  isActive: boolean
}

export function useTimelineViewport({ selectedSessionId, history, activeTurn, latestSteeringId, isActive }: TimelineViewportOptions) {
  const [followLatest, setFollowLatest] = useState(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [railOverlay, setRailOverlay] = useState<HTMLElement | null>(null)
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(null)
  const [composer, setComposer] = useState<HTMLDivElement | null>(null)
  const messageScrollAreaRef = useRef<HTMLDivElement>(null)
  const navigationInProgress = useRef(false)
  const returningToBottom = useRef(false)
  const returnToBottomDeadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const initialPositioning = useRef(true)
  const navigationFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const followLatestRef = useRef(followLatest)
  const showScrollToBottomRef = useRef(showScrollToBottom)
  const layoutScrollTop = useRef<number | undefined>(undefined)
  const positionedTurn = useRef<string | undefined>(undefined)
  const previouslyScrolledSessionId = useRef(selectedSessionId)
  const scrollFrame = useRef<number | undefined>(undefined)
  const executionTransitions = useRef(new Set<Element>())
  const pendingFinalAnswer = useRef<string | undefined>(undefined)
  const readingPositions = useRef(new Map<string, TimelineReadingPosition>())
  const timelineScrollController = useRef<TimelineScrollController | null>(null)
  const restoringPosition = useRef<TimelineReadingPosition | undefined>(undefined)
  const cancelReturnToBottom = useCallback(() => {
    clearTimeout(returnToBottomDeadline.current)
    returnToBottomDeadline.current = undefined
    if (returningToBottom.current) navigationInProgress.current = false
    returningToBottom.current = false
  }, [])
  const executionIsTransitioning = useCallback(() => {
    for (const element of executionTransitions.current) {
      if (!element.isConnected) executionTransitions.current.delete(element)
    }
    return executionTransitions.current.size > 0
  }, [])
  const scheduleScroll = useCallback((scroll: () => void) => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      scroll()
    })
  }, [])
  useLayoutEffect(() => () => {
    cancelReturnToBottom()
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = undefined
    executionTransitions.current.clear()
    pendingFinalAnswer.current = undefined
  }, [selectedSessionId, scrollViewport, cancelReturnToBottom])
  const setFollowingLatest = useCallback((value: boolean) => {
    restoringPosition.current = undefined
    if (!value) initialPositioning.current = false
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
    if (!selectedSessionId || !followLatestRef.current || !scrollViewport) return
    pendingFinalAnswer.current = turnId
    scheduleScroll(() => {
      if (!followLatestRef.current || navigationInProgress.current || executionIsTransitioning()) return
      const answer = [...(messageScrollAreaRef.current?.querySelectorAll<HTMLElement>('[data-final-answer-turn-id]') ?? [])].find((element) => element.dataset.finalAnswerTurnId === turnId)
      if (!answer) return
      pendingFinalAnswer.current = undefined
      const offset = answer.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top
      scrollViewport.scrollTo({ top: Math.max(0, scrollViewport.scrollTop + offset - 48) })
    })
  }, [selectedSessionId, scrollViewport, scheduleScroll, executionIsTransitioning])

  const followFinalAnswer = useCallback(() => {
    if (!selectedSessionId || !followLatestRef.current || !scrollViewport) return
    scheduleScroll(() => {
      if (!followLatestRef.current || navigationInProgress.current || executionIsTransitioning()) return
      const bottom = Math.max(0, scrollViewport.scrollHeight - scrollViewport.clientHeight)
      if (Math.abs(scrollViewport.scrollTop - bottom) > 1) scrollViewport.scrollTop = bottom
    })
  }, [selectedSessionId, scrollViewport, scheduleScroll, executionIsTransitioning])

  const finishReturnToBottom = useCallback(() => {
    if (!scrollViewport || !returningToBottom.current) return
    cancelReturnToBottom()
    clearTimeout(navigationFallback.current)
    setFollowingLatest(true)
    initialPositioning.current = true
    scrollViewport.scrollTo({ top: scrollViewport.scrollHeight, behavior: 'instant' })
    if (showScrollToBottomRef.current) {
      showScrollToBottomRef.current = false
      setShowScrollToBottom(false)
    }
  }, [scrollViewport, cancelReturnToBottom, setFollowingLatest])

  const rememberReadingPosition = useCallback(() => {
    const controller = timelineScrollController.current
    if (!scrollViewport || !controller || controller.sessionId !== previouslyScrolledSessionId.current || restoringPosition.current) return
    const position = controller.capture()
    if (position) readingPositions.current.set(controller.sessionId, { ...position, atBottom: initialPositioning.current || shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, false) })
  }, [scrollViewport])

  const restoreReadingPosition = useCallback(() => {
    scheduleScroll(() => {
      const controller = timelineScrollController.current
      const position = restoringPosition.current
      if (!position || !controller || controller.sessionId !== previouslyScrolledSessionId.current) return
      if (controller.restore(position) === 'missing') {
        setFollowingLatest(true)
        initialPositioning.current = true
        followFinalAnswer()
      }
    })
  }, [scheduleScroll, setFollowingLatest, followFinalAnswer])

  const registerTimelineScroll = useCallback((controller: TimelineScrollController | null) => {
    timelineScrollController.current = controller
    if (controller && restoringPosition.current) restoreReadingPosition()
  }, [restoreReadingPosition])

  useEffect(() => {
    if (!selectedSessionId || !scrollViewport) return
    let previousScrollHeight = scrollViewport.scrollHeight
    let previousViewportHeight = scrollViewport.clientHeight
    let previousScrollTop = scrollViewport.scrollTop
    const updateFollowLatest = (scrollingDown = false) => {
      if (returningToBottom.current) return
      if (restoringPosition.current) { restoreReadingPosition(); return }
      const resized = previousScrollHeight !== scrollViewport.scrollHeight || previousViewportHeight !== scrollViewport.clientHeight
      previousScrollHeight = scrollViewport.scrollHeight
      previousViewportHeight = scrollViewport.clientHeight
      if (executionIsTransitioning()) return
      // Measure here; defer writes so scroll and resize callbacks cannot feed each other.
      // Layout scrolls during initial measurement must not count as the reader scrolling up.
      const initialLayoutScroll = initialPositioning.current && !shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, false)
      if ((resized || initialLayoutScroll) && followLatestRef.current && !navigationInProgress.current) {
        followFinalAnswer()
        return
      }
      // Only downward scrolling may resume a follow that the reader interrupted.
      const next = (followLatestRef.current || (scrollingDown && !resized)) && shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, navigationInProgress.current)
      const show = !shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, false)
      if (showScrollToBottomRef.current !== show) {
        showScrollToBottomRef.current = show
        setShowScrollToBottom(show)
      }
      setFollowingLatest(next)
    }
    const completeNavigation = () => {
      if (returningToBottom.current) { finishReturnToBottom(); return }
      clearTimeout(navigationFallback.current)
      navigationFallback.current = undefined
      navigationInProgress.current = false
      returningToBottom.current = false
      updateFollowLatest()
    }
    const handleScroll = () => {
      const scrollingDown = scrollViewport.scrollTop > previousScrollTop
      previousScrollTop = scrollViewport.scrollTop
      updateFollowLatest(scrollingDown)
      rememberReadingPosition()
      if (!navigationInProgress.current || returningToBottom.current) return
      clearTimeout(navigationFallback.current)
      navigationFallback.current = setTimeout(completeNavigation, 150)
    }
    const interruptNavigation = (event: Event) => {
      if (event.type === 'keydown' && event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
      setFollowingLatest(false)
      pendingFinalAnswer.current = undefined
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = undefined
      if (!returningToBottom.current) return
      clearTimeout(navigationFallback.current)
      cancelReturnToBottom()
      scrollViewport.scrollTo({ top: scrollViewport.scrollTop, behavior: 'instant' })
    }
    const pauseExecutionFollow = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-execution-toggle]')) return
      interruptNavigation(event)
    }
    const handleExecutionTransition = (event: TransitionEvent) => {
      if (!(event.target instanceof Element) || !event.target.classList.contains('execution-collapse') || event.propertyName !== 'grid-template-rows') return
      if (event.type === 'transitionrun') {
        executionTransitions.current.add(event.target)
        return
      }
      executionTransitions.current.delete(event.target)
      if (executionIsTransitioning()) return
      // Wait for the virtualizer's final height measurement before repositioning.
      scheduleScroll(() => {
        if (executionIsTransitioning()) return
        if (pendingFinalAnswer.current) scrollToFinalAnswer(pendingFinalAnswer.current)
        else followFinalAnswer()
      })
    }
    const observer = new ResizeObserver(() => {
      updateFollowLatest()
      rememberReadingPosition()
    })
    observer.observe(scrollViewport)
    if (scrollViewport.firstElementChild) observer.observe(scrollViewport.firstElementChild)
    scrollViewport.addEventListener('wheel', interruptNavigation, { passive: true })
    scrollViewport.addEventListener('touchstart', interruptNavigation, { passive: true })
    scrollViewport.addEventListener('pointerdown', interruptNavigation)
    scrollViewport.addEventListener('keydown', interruptNavigation)
    scrollViewport.addEventListener('scroll', handleScroll, { passive: true })
    scrollViewport.addEventListener('scrollend', completeNavigation)
    scrollViewport.addEventListener('click', pauseExecutionFollow, true)
    scrollViewport.addEventListener('transitionrun', handleExecutionTransition)
    scrollViewport.addEventListener('transitionend', handleExecutionTransition)
    scrollViewport.addEventListener('transitioncancel', handleExecutionTransition)
    return () => {
      clearTimeout(navigationFallback.current)
      observer.disconnect()
      scrollViewport.removeEventListener('wheel', interruptNavigation)
      scrollViewport.removeEventListener('touchstart', interruptNavigation)
      scrollViewport.removeEventListener('pointerdown', interruptNavigation)
      scrollViewport.removeEventListener('keydown', interruptNavigation)
      scrollViewport.removeEventListener('scroll', handleScroll)
      scrollViewport.removeEventListener('scrollend', completeNavigation)
      scrollViewport.removeEventListener('click', pauseExecutionFollow, true)
      scrollViewport.removeEventListener('transitionrun', handleExecutionTransition)
      scrollViewport.removeEventListener('transitionend', handleExecutionTransition)
      scrollViewport.removeEventListener('transitioncancel', handleExecutionTransition)
    }
  }, [selectedSessionId, scrollViewport, setFollowingLatest, followFinalAnswer, scrollToFinalAnswer, scheduleScroll, executionIsTransitioning, rememberReadingPosition, restoreReadingPosition, cancelReturnToBottom, finishReturnToBottom])

  useLayoutEffect(() => {
    const selectedSessionChanged = previouslyScrolledSessionId.current !== selectedSessionId
    previouslyScrolledSessionId.current = selectedSessionId
    if (selectedSessionChanged) {
      cancelReturnToBottom()
      clearTimeout(navigationFallback.current)
      navigationInProgress.current = false
      returningToBottom.current = false
      layoutScrollTop.current = undefined
      const saved = readingPositions.current.get(selectedSessionId)
      setFollowingLatest(saved?.atBottom ?? true)
      initialPositioning.current = saved?.atBottom ?? true
      restoringPosition.current = saved && !saved.atBottom ? saved : undefined
      const show = Boolean(restoringPosition.current)
      showScrollToBottomRef.current = show
      setShowScrollToBottom(show)
      // Position before scroll events can mistake the new session's height for a user scroll.
      if (!restoringPosition.current) scrollViewport?.scrollTo({ top: selectedSessionId ? scrollViewport.scrollHeight : 0, behavior: 'instant' })
    }
    if (!selectedSessionId) return
    if (restoringPosition.current) { restoreReadingPosition(); return }
    if (navigationInProgress.current || (!followLatest && !selectedSessionChanged) || (initialPositioning.current && !history)) return
    scheduleScroll(() => {
      if (followLatestRef.current && !navigationInProgress.current && scrollViewport) scrollViewport.scrollTop = scrollViewport.scrollHeight
    })

  }, [followLatest, history, scrollViewport, selectedSessionId, scheduleScroll, setFollowingLatest, restoreReadingPosition, cancelReturnToBottom])

  useLayoutEffect(() => {
    const key = activeTurn ? `${selectedSessionId}:${activeTurn.startedAt}` : undefined
    if (!isActive || !key || !scrollViewport || positionedTurn.current === key || !followLatestRef.current || navigationInProgress.current) return
    positionedTurn.current = key
    scheduleScroll(() => { if (followLatestRef.current && !navigationInProgress.current) scrollViewport.scrollTop = scrollViewport.scrollHeight })
  }, [activeTurn, isActive, scrollViewport, selectedSessionId, scheduleScroll])

  useLayoutEffect(() => {
    if (!latestSteeringId || !scrollViewport || !followLatestRef.current || navigationInProgress.current) return
    scheduleScroll(() => { if (followLatestRef.current) scrollViewport.scrollTop = scrollViewport.scrollHeight })
  }, [latestSteeringId, scrollViewport, scheduleScroll])

  const rememberLayoutPosition = useCallback(() => {
    layoutScrollTop.current = scrollViewport?.scrollTop
  }, [scrollViewport])
  const restoreLayoutPosition = useCallback(() => {
    if (layoutScrollTop.current === undefined || !scrollViewport) return
    scrollViewport.scrollTo({ top: layoutScrollTop.current })
    layoutScrollTop.current = undefined
  }, [scrollViewport])

  const scrollToBottom = useCallback(() => {
    if (!scrollViewport) return
    cancelReturnToBottom()
    clearTimeout(navigationFallback.current)
    layoutScrollTop.current = undefined
    pendingFinalAnswer.current = undefined
    setFollowingLatest(false)
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    navigationInProgress.current = true
    returningToBottom.current = true
    if (behavior === 'instant') finishReturnToBottom()
    else {
      // Virtual-list measurements must not extend the return beyond this deadline.
      returnToBottomDeadline.current = setTimeout(finishReturnToBottom, 1500)
      scrollViewport.scrollTo({ top: scrollViewport.scrollHeight, behavior })
    }
  }, [scrollViewport, setFollowingLatest, cancelReturnToBottom, finishReturnToBottom])

  const jumpToTurn = useCallback((_turnId: string, scrollTo: (behavior: ScrollBehavior) => void, alignment: TurnJumpAlignment) => {
    if (!scrollViewport) return
    cancelReturnToBottom()
    clearTimeout(navigationFallback.current)
    setFollowingLatest(false)
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    navigationInProgress.current = behavior === 'smooth'
    scrollTo(behavior)
    if (alignment === 'end') requestAnimationFrame(() => scrollViewport.scrollTo({ behavior, top: scrollViewport.scrollHeight }))
  }, [scrollViewport, setFollowingLatest, cancelReturnToBottom])

  return { setComposer, showScrollToBottom, scrollToBottom, followLatest, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot, scrollToFinalAnswer, followFinalAnswer, jumpToTurn, rememberLayoutPosition, restoreLayoutPosition, rememberReadingPosition, registerTimelineScroll }
}
