import { describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import { diagramConfig, fitDiagramScale, safeSvg } from './mermaid-render.js'

describe('Mermaid rendering', () => {
  it('uses SVG labels and classic flowchart styling with the installed Mermaid version', () => {
    for (const dark of [false, true]) {
      mermaid.initialize(diagramConfig(dark))
      const config = mermaid.mermaidAPI.getConfig()
      expect(config.htmlLabels).toBe(false)
      expect(config.flowchart?.look).toBe('classic')
      expect(config.flowchart?.theme).toBe('base')
      expect(config.securityLevel).toBe('strict')
      expect(config.secure).toEqual(expect.arrayContaining(['htmlLabels', 'flowchart', 'securityLevel']))
    }
  })

  it('fits tall and wide diagrams while keeping small graphs at natural size', () => {
    expect(fitDiagramScale({ width: 1000, height: 2000 }, { width: 1032, height: 1032 })).toBe(0.5)
    expect(fitDiagramScale({ width: 2000, height: 1000 }, { width: 1032, height: 1032 })).toBe(0.5)
    expect(fitDiagramScale({ width: 100, height: 100 }, { width: 1032, height: 1032 })).toBe(1)
    expect(fitDiagramScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(0.01)
  })

  it('keeps SVG sanitization enabled when labels are fixed', () => {
    const sanitize = vi.fn(() => '<svg><text>中文</text></svg>')
    expect(safeSvg({ sanitize }, 'untrusted svg')).toContain('中文')
    expect(sanitize).toHaveBeenCalledWith('untrusted svg', expect.objectContaining({
      FORBID_TAGS: expect.arrayContaining(['foreignObject', 'script', 'iframe', 'image']),
      FORBID_ATTR: expect.arrayContaining(['href', 'xlink:href']),
    }))
  })
})
