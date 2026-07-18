function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function resolveVideoGenerationModel(
  payload: Record<string, unknown> | null | undefined,
  fallback?: string | null,
): string | null {
  const firstLastFrame = asRecord(payload?.firstLastFrame)
  if (Object.keys(firstLastFrame).length > 0) {
    return firstString([payload?.videoModel, firstLastFrame.flModel, fallback, payload?.modelId, payload?.model])
  }
  return firstString([payload?.videoModel, payload?.modelId, payload?.model, fallback])
}
