import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query/keys'
import {
  selectImageModelOptions,
  selectUpscaleModelOptions,
  invalidateUserModels,
  userModelsQueryOptions,
} from '@/lib/query/hooks/useUserModels'
import { buildComfyWorkflowModelOption, isExecutableOwnedWorkflow, isTestedOwnedUpscaleWorkflow } from '@/lib/comfyui/workflow-model-option'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

function response(
  image: Array<Record<string, unknown>>,
  video: Array<Record<string, unknown>> = [],
  upscale: Array<Record<string, unknown>> = [],
) {
  return new Response(JSON.stringify({ llm: [], image, video, audio: [], lipsync: [], upscale }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

describe('user model query cache', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('keeps generation and upscale workflow choices in separate selectors', async () => {
    const queryClient = client()
    const generation = {
      value: 'comfyui::generate', label: 'Generate', provider: 'comfyui',
      workflowPurpose: 'generation' as const,
    }
    const upscale = {
      value: 'comfyui::upscale', label: 'Upscale', provider: 'comfyui',
      workflowPurpose: 'upscale' as const,
    }
    apiFetchMock.mockResolvedValueOnce(response([generation], [], [upscale]))

    const payload = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))

    expect(selectImageModelOptions(payload)).toEqual([generation])
    expect(selectUpscaleModelOptions(payload)).toEqual([upscale])
  })

  it('exposes the pinned published workflow version required by upscale task routes', () => {
    expect(buildComfyWorkflowModelOption({
      id: 'wf-upscale', name: '4x upscale', mediaType: 'image',
      currentVersion: { id: 'version-7', purpose: 'upscale' },
    })).toEqual({
      value: 'comfyui::wf-upscale', label: '4x upscale', provider: 'comfyui', providerName: 'ComfyUI',
      workflowPurpose: 'upscale', workflowVersionId: 'version-7',
    })
  })

  it('advertises first-last-frame support only for a fully bound video workflow contract', () => {
    const workflow = {
      id: 'wf-first-last', name: 'First Last', mediaType: 'video',
      currentVersion: {
        id: 'version-first-last', purpose: 'generation',
        variableDefinitions: [
          { name: 'sourceImage', type: 'image_ref', required: true },
          { name: 'lastFrame', type: 'image_ref', required: true },
        ],
        bindingSpec: [
          { nodeId: '1', inputPath: 'image', variable: 'sourceImage', valueType: 'image_ref' },
          { nodeId: '2', inputPath: 'image', variable: 'lastFrame', valueType: 'image_ref' },
        ],
      },
    }

    expect(buildComfyWorkflowModelOption(workflow).capabilities).toEqual({
      video: { firstlastframe: true },
    })
    expect(buildComfyWorkflowModelOption({
      ...workflow,
      currentVersion: {
        ...workflow.currentVersion,
        bindingSpec: workflow.currentVersion.bindingSpec.slice(0, 1),
      },
    }).capabilities).toBeUndefined()
  })

  it('does not advertise another user or untested upscale workflow as executable', () => {
    const base = {
      id: 'wf-upscale', name: 'Upscale', mediaType: 'image',
      currentVersionId: 'version-1',
      currentVersion: {
        id: 'version-1', purpose: 'upscale', publishedAt: new Date(),
        contentHash: 'sha256:canonical',
        lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-a' },
      },
    }
    expect(isTestedOwnedUpscaleWorkflow(base, 'user-a')).toBe(true)
    expect(isTestedOwnedUpscaleWorkflow({ ...base, currentVersion: { ...base.currentVersion, lastSuccessfulTestAt: null } }, 'user-a')).toBe(false)
    expect(isTestedOwnedUpscaleWorkflow({ ...base, currentVersion: { ...base.currentVersion, lastTestConnection: { userId: 'user-b' } } }, 'user-a')).toBe(false)
  })

  it('discovers generation workflows only when the pinned immutable version is published and tested by its owner', () => {
    const valid = {
      id: 'wf-generation', name: 'Generate', mediaType: 'video', currentVersionId: 'version-1',
      currentVersion: {
        id: 'version-1', purpose: 'generation', publishedAt: new Date(),
        contentHash: 'sha256:canonical', lastSuccessfulTestAt: new Date(),
        lastTestConnection: { userId: 'user-a' },
      },
    }
    expect(isExecutableOwnedWorkflow(valid, 'user-a')).toBe(true)
    expect(isExecutableOwnedWorkflow({ ...valid, currentVersionId: 'version-2' }, 'user-a')).toBe(false)
    expect(isExecutableOwnedWorkflow({ ...valid, currentVersion: { ...valid.currentVersion, publishedAt: null } }, 'user-a')).toBe(false)
    expect(isExecutableOwnedWorkflow({ ...valid, currentVersion: { ...valid.currentVersion, contentHash: '' } }, 'user-a')).toBe(false)
    expect(isExecutableOwnedWorkflow({ ...valid, currentVersion: { ...valid.currentVersion, lastSuccessfulTestAt: null } }, 'user-a')).toBe(false)
    expect(isExecutableOwnedWorkflow({ ...valid, currentVersion: { ...valid.currentVersion, lastTestConnection: { userId: 'user-b' } } }, 'user-a')).toBe(false)
  })

  it('returns full image options and exposes a newly published workflow after invalidation', async () => {
    const queryClient = client()
    const cloud = {
      value: 'cloud::image', label: 'Cloud Image', provider: 'cloud', providerName: 'Cloud Inc',
      capabilities: { image: { resolutionOptions: ['1024x1024'] } },
    }
    apiFetchMock.mockResolvedValueOnce(response([cloud]))
    const initial = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    expect(selectImageModelOptions(initial)).toEqual([cloud])

    const workflow = { value: 'comfyui::wf-new', label: 'New Workflow', provider: 'comfyui', providerName: 'ComfyUI' }
    apiFetchMock.mockResolvedValueOnce(response([cloud, workflow]))
    await invalidateUserModels(queryClient)
    const refreshed = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    expect(selectImageModelOptions(refreshed)).toEqual([cloud, workflow])
  })

  it('does not share cached user models when the authenticated user changes', async () => {
    const queryClient = client()
    apiFetchMock
      .mockResolvedValueOnce(response([{ value: 'comfyui::a', label: 'A', provider: 'comfyui' }]))
      .mockResolvedValueOnce(response([{ value: 'comfyui::b', label: 'B', provider: 'comfyui' }]))

    const userA = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    const userB = await queryClient.fetchQuery(userModelsQueryOptions('user-b'))
    expect(userA.image[0].value).toBe('comfyui::a')
    expect(userB.image[0].value).toBe('comfyui::b')
    expect(queryClient.getQueryData(queryKeys.userModels.scope('user-a'))).toEqual(userA)
    expect(queryClient.getQueryData(queryKeys.userModels.scope('user-b'))).toEqual(userB)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
})
