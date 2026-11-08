export const bodyFontSizes = [14, 15, 16, 18, 20] as const

export function normalizeBodyFontSize(value: unknown): number {
  return bodyFontSizes.find((size) => size === value) ?? 15
}
