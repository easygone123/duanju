const DIMENSION_DRIVEN_ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '21:9', '9:21', '8:3', '27:32',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalName(value: unknown) {
  return typeof value === 'string' ? value.replace(/[-_]/g, '').toLowerCase() : ''
}

export function readComfyAspectRatioOptions(variableDefinitions: unknown): string[] {
  if (!Array.isArray(variableDefinitions)) return []
  const aspectRatio = variableDefinitions.find((definition) => (
    isRecord(definition) && canonicalName(definition.name) === 'aspectratio'
  ))
  if (isRecord(aspectRatio)) {
    return Array.isArray(aspectRatio.options)
      ? aspectRatio.options.filter((value): value is string => typeof value === 'string')
      : []
  }
  const hasWidth = variableDefinitions.some((definition) => (
    isRecord(definition) && canonicalName(definition.name) === 'width' && definition.type === 'number'
  ))
  const hasHeight = variableDefinitions.some((definition) => (
    isRecord(definition) && canonicalName(definition.name) === 'height' && definition.type === 'number'
  ))
  return hasWidth && hasHeight ? [...DIMENSION_DRIVEN_ASPECT_RATIOS] : []
}

export function resolveComfyDimensionsForAspectRatio(input: {
  aspectRatio: unknown
  defaultWidth?: unknown
  defaultHeight?: unknown
}): { width: number; height: number } | null {
  if (typeof input.aspectRatio !== 'string'
    || !(DIMENSION_DRIVEN_ASPECT_RATIOS as readonly string[]).includes(input.aspectRatio)) return null
  const [ratioWidth, ratioHeight] = input.aspectRatio.split(':').map(Number)
  if (!ratioWidth || !ratioHeight) return null
  const defaultWidth = typeof input.defaultWidth === 'number' && input.defaultWidth > 0
    ? input.defaultWidth : 832
  const defaultHeight = typeof input.defaultHeight === 'number' && input.defaultHeight > 0
    ? input.defaultHeight : 480
  const targetArea = defaultWidth * defaultHeight
  const rawUnit = Math.sqrt(targetArea / (ratioWidth * ratioHeight))
  let unit = Math.max(16, Math.round(rawUnit / 16) * 16)
  const maxDimension = Math.max(ratioWidth, ratioHeight)
  if (maxDimension * unit > 4096) {
    unit = Math.floor(4096 / maxDimension / 16) * 16
  }
  if (unit < 16) return null
  return { width: ratioWidth * unit, height: ratioHeight * unit }
}
