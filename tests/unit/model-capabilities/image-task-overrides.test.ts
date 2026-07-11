import { describe, expect, it } from 'vitest'
import { resolveImageTaskGenerationOptions } from '@/lib/config-service'

describe('image task capability overrides', () => {
  const projectModelConfig = {
    capabilityDefaults: {},
    capabilityOverrides: { 'fal::banana-2': { resolution: '1K' } },
  }

  it('lets a validated task resolution override the project selection', () => {
    expect(resolveImageTaskGenerationOptions({
      imageModel: 'fal::banana-2', projectModelConfig, taskSelections: { resolution: '4K' },
    })).toEqual({ resolution: '4K' })
  })

  it('rejects a task value unsupported by the selected strict model', () => {
    expect(() => resolveImageTaskGenerationOptions({
      imageModel: 'fal::banana-2', projectModelConfig, taskSelections: { resolution: '8K' },
    })).toThrow(/CAPABILITY_VALUE_NOT_ALLOWED/)
  })
})
