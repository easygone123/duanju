import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractCapabilityFields } from '@/lib/model-capabilities/ui-fields'
import { applyImageTaskCapabilityChange } from '@/lib/model-capabilities/ui-fields'
import { buildPanelRegenerationPayload } from '@/lib/query/mutations/storyboard-panel-mutations'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const dropdownCapture = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
const imageModels = vi.hoisted(() => ({
  current: {
    llm: [], audio: [], lipsync: [],
    image: [{
      value: 'cloud::image', label: 'Cloud Image', provider: 'cloud', providerName: 'Cloud Inc',
      capabilities: { image: { resolutionOptions: ['1024x1024'] } },
    }, { value: 'comfyui::workflow-1', label: 'Portrait', provider: 'comfyui', providerName: 'ComfyUI' }],
    video: [{ value: 'comfyui::video-1', label: 'Video', provider: 'comfyui' }],
  },
}))

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/lib/query/hooks/useUserModels', () => ({
  useUserModels: () => ({ data: imageModels.current, isLoading: false }),
  selectImageModelOptions: (payload: typeof imageModels.current | undefined) => payload?.image ?? [],
}))
vi.mock('@/components/ui/config-modals/ModelCapabilityDropdown', () => ({
  ModelCapabilityDropdown: (props: Record<string, unknown>) => {
    dropdownCapture.props = props
    return React.createElement('div', { 'data-testid': 'image-model-dropdown' })
  },
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons', () => ({
  default: () => null,
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionCandidateMode', () => ({
  default: () => null,
}))

import ImageSection from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSection'

describe('ImageSection model selection', () => {
  beforeEach(() => { dropdownCapture.props = null })

  it('renders the shared capability dropdown with full image-only user model options', () => {
    const html = renderToStaticMarkup(React.createElement(ImageSection, {
      panelId: 'panel-1', imageUrl: null, globalPanelNumber: 1, shotType: 'close-up', videoRatio: '9:16',
      isDeleting: false, isModifying: false, isSubmittingPanelImageTask: false, failedError: null,
      candidateData: null, onRegeneratePanelImage: vi.fn(), onOpenEditModal: vi.fn(), onOpenAIDataModal: vi.fn(),
      onSelectCandidateIndex: vi.fn(), onConfirmCandidate: vi.fn(), onCancelCandidate: vi.fn(), onClearError: vi.fn(),
    }))

    expect(html).toContain('data-testid="image-model-dropdown"')
    expect(dropdownCapture.props?.models).toEqual(imageModels.current.image)
    expect(dropdownCapture.props?.models).not.toContainEqual(imageModels.current.video[0])
    expect(dropdownCapture.props?.models).toContainEqual(expect.objectContaining({
      providerName: 'Cloud Inc', capabilities: { image: { resolutionOptions: ['1024x1024'] } },
    }))
    expect(extractCapabilityFields(imageModels.current.image[0].capabilities, 'image')).toEqual([
      { field: 'resolution', label: 'Resolution', options: ['1024x1024'] },
    ])
  })

  it('turns a capability dropdown change into the selected-model regeneration POST body', () => {
    const generationOptions = applyImageTaskCapabilityChange({}, 'resolution', '4K', '1K')
    expect(buildPanelRegenerationPayload('panel-1', 1, 'fal::banana-2', generationOptions)).toEqual({
      panelId: 'panel-1', count: 1, imageModel: 'fal::banana-2', generationOptions: { resolution: '4K' },
    })
  })
})
