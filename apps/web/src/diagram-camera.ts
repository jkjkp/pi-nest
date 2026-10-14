import { fitDiagramScale } from './mermaid-render.js'

export type DiagramCamera = { scale: number; x: number; y: number; width: number; height: number; fit: boolean }
type Size = { width: number; height: number }

export function fitDiagramCamera(diagram: Size, viewport: Size): DiagramCamera {
  const scale = fitDiagramScale(diagram, viewport)
  return { ...viewport, scale, x: (viewport.width - diagram.width * scale) / 2, y: (viewport.height - diagram.height * scale) / 2, fit: true }
}

export function zoomDiagramCamera(camera: DiagramCamera, scale: number, anchor = { x: camera.width / 2, y: camera.height / 2 }): DiagramCamera {
  const next = Math.max(0.01, Math.min(16, Number.isFinite(scale) ? scale : camera.scale))
  const ratio = next / camera.scale
  return { ...camera, scale: next, x: anchor.x - (anchor.x - camera.x) * ratio, y: anchor.y - (anchor.y - camera.y) * ratio, fit: false }
}

export function panDiagramCamera(camera: DiagramCamera, x: number, y: number): DiagramCamera {
  return { ...camera, x: camera.x + x, y: camera.y + y, fit: false }
}

export function resizeDiagramCamera(camera: DiagramCamera | undefined, diagram: Size, viewport: Size): DiagramCamera {
  if (!camera) return zoomDiagramCamera(fitDiagramCamera(diagram, viewport), 0.6)
  if (camera.fit) return fitDiagramCamera(diagram, viewport)
  return { ...camera, ...viewport, x: camera.x + (viewport.width - camera.width) / 2, y: camera.y + (viewport.height - camera.height) / 2 }
}
