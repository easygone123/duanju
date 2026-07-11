import type { CapabilityValue, ModelCapabilities } from '@/lib/model-config-contract'

export interface ModelCapabilityField {
  field: string
  options: CapabilityValue[]
  label: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCapabilityValue(value: unknown): value is CapabilityValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

export function extractCapabilityFields(
  capabilities: ModelCapabilities | undefined,
  namespace: 'llm' | 'image' | 'video' | 'audio',
): ModelCapabilityField[] {
  const rawNamespace = capabilities?.[namespace]
  if (!isRecord(rawNamespace)) return []
  return Object.entries(rawNamespace)
    .filter(([, value]) => Array.isArray(value) && value.length > 0 && value.every(isCapabilityValue))
    .filter(([key]) => key.endsWith('Options'))
    .map(([key, value]) => {
      const field = key.slice(0, -'Options'.length)
      return { field, options: value as CapabilityValue[], label: toFieldLabel(field) }
    })
}
