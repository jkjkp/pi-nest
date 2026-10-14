import { describe, expect, it } from 'vitest'
import { fitDiagramCamera, panDiagramCamera, resizeDiagramCamera, zoomDiagramCamera } from './diagram-camera.js'

describe('diagram camera', () => {
  const diagram = { width: 1200, height: 3600 }
  const viewport = { width: 1000, height: 320 }

  it('starts at 60% and preserves that scale when opening a larger canvas', () => {
    const camera = resizeDiagramCamera(undefined, diagram, viewport)
    expect(camera.scale).toBe(0.6)
    expect(camera.x + diagram.width * camera.scale / 2).toBe(viewport.width / 2)
    expect(resizeDiagramCamera(camera, diagram, { width: 1400, height: 800 }).scale).toBe(0.6)
  })

  it('fits and centers a complete long diagram', () => {
    const camera = fitDiagramCamera(diagram, viewport)
    expect(camera.scale).toBe(0.08)
    expect(camera.y).toBe(16)
    expect(camera.x + diagram.width * camera.scale / 2).toBe(viewport.width / 2)
  })

  it('keeps the graph point under the cursor fixed during arbitrary zoom', () => {
    const camera = fitDiagramCamera(diagram, viewport)
    const anchor = { x: 650, y: 180 }
    const graphPoint = { x: (anchor.x - camera.x) / camera.scale, y: (anchor.y - camera.y) / camera.scale }
    const zoomed = zoomDiagramCamera(camera, 1.357, anchor)
    expect(zoomed.x + graphPoint.x * zoomed.scale).toBeCloseTo(anchor.x)
    expect(zoomed.y + graphPoint.y * zoomed.scale).toBeCloseTo(anchor.y)
    expect(zoomed.scale).toBe(1.357)
    expect(zoomed.fit).toBe(false)
  })

  it('allows panning beyond every edge even when the graph is smaller than the viewport', () => {
    const camera = fitDiagramCamera({ width: 20, height: 20 }, viewport)
    const moved = panDiagramCamera(camera, -4000, 5000)
    expect(moved.x).toBe(camera.x - 4000)
    expect(moved.y).toBe(camera.y + 5000)
    expect(moved.scale).toBe(camera.scale)
    expect(moved.fit).toBe(false)
  })

  it('preserves the viewed graph center and scale across modal and inline sizes', () => {
    const original = panDiagramCamera(zoomDiagramCamera(fitDiagramCamera(diagram, viewport), 1.35), 180, -90)
    const larger = resizeDiagramCamera(original, diagram, { width: 1400, height: 800 })
    expect((larger.width / 2 - larger.x) / larger.scale).toBeCloseTo((original.width / 2 - original.x) / original.scale)
    expect((larger.height / 2 - larger.y) / larger.scale).toBeCloseTo((original.height / 2 - original.y) / original.scale)
    expect(resizeDiagramCamera(larger, diagram, viewport)).toEqual(original)
    expect(resizeDiagramCamera(fitDiagramCamera(diagram, viewport), diagram, { width: 1400, height: 800 }).fit).toBe(true)
  })

  it('limits extreme or invalid scales without corrupting the camera', () => {
    const camera = fitDiagramCamera(diagram, viewport)
    expect(zoomDiagramCamera(camera, 0).scale).toBe(0.01)
    expect(zoomDiagramCamera(camera, 1000).scale).toBe(16)
    expect(zoomDiagramCamera(camera, Number.NaN).scale).toBe(camera.scale)
  })
})
