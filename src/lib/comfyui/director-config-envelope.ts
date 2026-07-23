export type DirectorConfigKind = 'ltx' | 'bernini'

function parseRecord(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function unwrapDirectorConfig(value: unknown, kind: DirectorConfigKind): unknown {
  const parsed = parseRecord(value)
  if (parsed?.kind !== 'director-configs') return value
  return parsed[kind]
}

export function mergeDirectorConfig(
  currentValue: unknown,
  kind: DirectorConfigKind,
  nextValue: unknown,
) {
  const current = parseRecord(currentValue)
  const envelope: Record<string, unknown> = current?.kind === 'director-configs'
    ? { ...current }
    : current?.kind === 'bernini-director'
      ? { kind: 'director-configs', version: 1, bernini: current }
      : current
        ? { kind: 'director-configs', version: 1, ltx: current }
        : { kind: 'director-configs', version: 1 }
  envelope.kind = 'director-configs'
  envelope.version = 1
  envelope[kind] = nextValue
  return JSON.stringify(envelope)
}
