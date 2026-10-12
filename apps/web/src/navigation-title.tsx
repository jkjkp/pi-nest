import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function NavigationTitle({ children, stopped = false, className = '' }: { children: string; stopped?: boolean; className?: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)

  useEffect(() => {
    const viewport = viewportRef.current
    const text = textRef.current
    const button = viewport?.closest('button')
    if (!viewport || !text || !button) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const hover = window.matchMedia('(hover: hover) and (pointer: fine)')
    let distance = 0
    let animation: Animation | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointerInside = false
    let keyboardFocused = false

    function reset(animate = false) {
      clearTimeout(timer)
      const from = getComputedStyle(text!).transform
      animation?.cancel()
      viewport!.dataset.position = 'start'
      if (animate && !reducedMotion.matches && from !== 'none') {
        animation = text!.animate([{ transform: from }, { transform: 'translateX(0)' }], { duration: 150, easing: 'ease-out' })
      }
    }
    function measure() {
      reset()
      distance = Math.max(0, text!.getBoundingClientRect().width - viewport!.clientWidth)
      viewport!.dataset.overflow = String(distance > 1)
      setTooltipOpen(false)
    }
    function start() {
      if (stopped || distance <= 1 || reducedMotion.matches || (!pointerInside && !keyboardFocused)) return
      reset()
      animation = text!.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }], { delay: 350, duration: distance / 45 * 1000, easing: 'linear', fill: 'forwards' })
      timer = setTimeout(() => { viewport!.dataset.position = 'moving' }, 350)
      animation.onfinish = () => { viewport!.dataset.position = 'end' }
    }
    function enter() { pointerInside = hover.matches; start() }
    function leave() { pointerInside = false; if (!keyboardFocused) reset(true) }
    function focus() {
      keyboardFocused = button!.matches(':focus-visible')
      setTooltipOpen(keyboardFocused && reducedMotion.matches && distance > 1 && !stopped)
      start()
    }
    function blur() { keyboardFocused = false; setTooltipOpen(false); if (!pointerInside) reset(true) }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(text)
    measure()
    viewport.addEventListener('pointerenter', enter)
    viewport.addEventListener('pointerleave', leave)
    button.addEventListener('focus', focus)
    button.addEventListener('blur', blur)
    reducedMotion.addEventListener('change', measure)
    hover.addEventListener('change', measure)
    return () => {
      reset()
      observer.disconnect()
      viewport.removeEventListener('pointerenter', enter)
      viewport.removeEventListener('pointerleave', leave)
      button.removeEventListener('focus', focus)
      button.removeEventListener('blur', blur)
      reducedMotion.removeEventListener('change', measure)
      hover.removeEventListener('change', measure)
    }
  }, [children, stopped])

  return <TooltipProvider><Tooltip open={tooltipOpen}><TooltipTrigger asChild><span className={`navigation-title min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left ${className}`} ref={viewportRef}><span className="inline-block w-max" ref={textRef}>{children}</span></span></TooltipTrigger><TooltipContent side="right">{children}</TooltipContent></Tooltip></TooltipProvider>
}
