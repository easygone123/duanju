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

  it('accepts only catalog-declared cloud aspect ratios', () => {
    expect(resolveImageTaskGenerationOptions({
      imageModel: 'fal::banana-2', projectModelConfig, taskSelections: { aspectRatio: '1:1' },
    })).toEqual({ resolution: '1K', aspectRatio: '1:1' })

    expect(() => resolveImageTaskGenerationOptions({
      imageModel: 'fal::banana-2', projectModelConfig, taskSelections: { aspectRatio: '999:999' },
    })).toThrow(/CAPABILITY_VALUE_NOT_ALLOWED/)
  })

  it('uses the published Comfy workflow variable options as its allowlist', () => {
    expect(resolveImageTaskGenerationOptions({
      imageModel: 'comfyui::workflow-1',
      projectModelConfig: { capabilityDefaults: {}, capabilityOverrides: {} },
      taskSelections: { aspectRatio: '16:9' },
      comfyAspectRatioOptions: ['1:1', '16:9'],
    })).toEqual({ aspectRatio: '16:9' })

    expect(() => resolveImageTaskGenerationOptions({
      imageModel: 'comfyui::workflow-1',
      projectModelConfig: { capabilityDefaults: {}, capabilityOverrides: {} },
      taskSelections: { aspectRatio: '999:999' },
      comfyAspectRatioOptions: ['1:1', '16:9'],
    })).toThrow(/CAPABILITY_VALUE_NOT_ALLOWED/)
  })
})
