import type { MermaidConfig } from 'mermaid'

export const maxSourceLength = 32 * 1024

export function diagramConfig(dark: boolean): MermaidConfig {
  return {
    htmlLabels: false,
    flowchart: { htmlLabels: false, look: 'classic', theme: 'base', useMaxWidth: false, wrappingWidth: 220, nodeSpacing: 32, rankSpacing: 44 },
    maxEdges: 500,
    maxTextSize: maxSourceLength,
    securityLevel: 'strict',
    // Source directives cannot undo the viewer's text, theme or safety settings.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'fontFamily', 'look', 'layout'],
    startOnLoad: false,
    theme: 'base',
    themeVariables: dark
      ? { background: '#232324', lineColor: '#a3a3a3', primaryBorderColor: '#737373', primaryColor: '#2c2c2e', primaryTextColor: '#cfd3d6', secondaryColor: '#353638', tertiaryColor: '#232324', fontSize: '16px' }
      : { background: '#ffffff', lineColor: '#64748b', primaryBorderColor: '#94a3b8', primaryColor: '#eff6ff', primaryTextColor: '#1f2937', secondaryColor: '#f8fafc', tertiaryColor: '#ffffff', fontSize: '16px' },
    fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  }
}

export function safeSvg(purifier: { sanitize: (svg: string, options: Record<string, unknown>) => string }, svg: string) {
  return purifier.sanitize(svg, {
    FORBID_ATTR: ['href', 'target', 'xlink:href'],
    FORBID_TAGS: ['a', 'foreignObject', 'iframe', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true },
  })
}

export function fitDiagramScale(diagram: { width: number; height: number }, viewport: { width: number; height: number }) {
  return Math.min(1, Math.max(0.01, Math.min((viewport.width - 32) / diagram.width, (viewport.height - 32) / diagram.height)))
}

