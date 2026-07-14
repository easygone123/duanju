import { describe, expect, it } from 'vitest'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo, isBillableTaskType } from '@/lib/billing/task-policy'
import type { TaskBillingInfo } from '@/lib/task/types'

function expectBillableInfo(info: TaskBillingInfo | null): Extract<TaskBillingInfo, { billable: true }> {
  expect(info).toBeTruthy()
  expect(info?.billable).toBe(true)
  if (!info || !info.billable) {
    throw new Error('Expected billable task billing info')
  }
  return info
}

describe('billing/task-policy', () => {
  const billingPayload = {
    analysisModel: 'anthropic/claude-sonnet-4',
    imageModel: 'seedream',
    videoModel: 'doubao-seedance-1-5-pro-251215',
  } as const

  it('builds TaskBillingInfo for every billable task type', () => {
    for (const taskType of Object.values(TASK_TYPE)) {
      if (!isBillableTaskType(taskType)) continue
      const info = expectBillableInfo(buildDefaultTaskBillingInfo(taskType, billingPayload))
      expect(info.taskType).toBe(taskType)
      expect(info.maxFrozenCost).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns null for a non-billable task type', () => {
    const fake = 'not_billable' as unknown as (typeof TASK_TYPE)[keyof typeof TASK_TYPE]
    expect(isBillableTaskType(fake)).toBe(false)
    expect(buildDefaultTaskBillingInfo(fake, {})).toBeNull()
  })

  it('builds text billing info from explicit model payload', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.ANALYZE_NOVEL, {
      analysisModel: 'anthropic/claude-sonnet-4',
    }))
    expect(info.apiType).toBe('text')
    expect(info.model).toBe('anthropic/claude-sonnet-4')
    expect(info.quantity).toBe(4200)
  })

  it.each([
    TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
    TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  ])('prefers the analysis model snapshot for %s', (taskType) => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(taskType, {
      analysisModelSnapshot: 'snapshot::analysis-model',
      analysisModel: 'configured::analysis-model',
      model: 'fallback::model',
    }))
    expect(info.model).toBe('snapshot::analysis-model')
  })

  it('ignores the viral analysis model snapshot for existing text tasks', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.ANALYZE_NOVEL, {
      analysisModelSnapshot: 'snapshot::analysis-model',
      analysisModel: 'configured::analysis-model',
      model: 'fallback::model',
    }))
    expect(info.model).toBe('configured::analysis-model')
  })

  it('keeps the generic model fallback for existing text tasks', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.ANALYZE_NOVEL, {
      model: 'fallback::model',
    }))
    expect(info.model).toBe('fallback::model')
  })

  it('returns null for missing required models in text/image/video tasks', () => {
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.ANALYZE_NOVEL, {})).toBeNull()
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, {})).toBeNull()
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {})).toBeNull()
  })

  it('honors candidateCount/count for image tasks', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, {
      candidateCount: 4,
      imageModel: 'seedream4',
    }))
    expect(info.apiType).toBe('image')
    expect(info.quantity).toBe(4)
    expect(info.model).toBe('seedream4')
  })

  it('builds video billing info from firstLastFrame.flModel', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {
      firstLastFrame: {
        flModel: 'doubao-seedance-1-0-pro-250528',
      },
      duration: 8,
    }))
    expect(info.apiType).toBe('video')
    expect(info.model).toBe('doubao-seedance-1-0-pro-250528')
    expect(info.quantity).toBe(1)
  })

  it('bills the actual first-last-frame cloud model even when the normal model is ComfyUI', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {
      videoModel: 'comfyui::wf-video',
      firstLastFrame: { flModel: 'doubao-seedance-1-0-pro-250528' },
    }))
    expect(info.model).toBe('doubao-seedance-1-0-pro-250528')
  })

  it('skips billing for the actual first-last-frame ComfyUI model even when normal is cloud', () => {
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {
      videoModel: 'doubao-seedance-1-0-pro-250528',
      firstLastFrame: { flModel: 'comfyui::wf-video' },
    })).toEqual({ billable: false, source: 'task', status: 'skipped' })
  })

  it('uses explicit lip sync model from payload', () => {
    const info = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.LIP_SYNC, {
      lipSyncModel: 'vidu::vidu-lipsync',
    }))
    expect(info.apiType).toBe('lip-sync')
    expect(info.model).toBe('vidu::vidu-lipsync')
    expect(info.quantity).toBe(1)
  })

  it.each([
    [TASK_TYPE.IMAGE_PANEL, { imageModel: 'comfyui::wf-image' }],
    [TASK_TYPE.VIDEO_PANEL, { videoModel: 'comfyui::wf-video' }],
  ])('marks ComfyUI generation as skipped and freezes zero for %s', (taskType, payload) => {
    expect(buildDefaultTaskBillingInfo(taskType, payload)).toEqual({
      billable: false,
      source: 'task',
      status: 'skipped',
    })
  })

  it('keeps existing cloud image and video billing unchanged', () => {
    const image = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, {
      imageModel: 'seedream4',
      candidateCount: 2,
    }))
    const video = expectBillableInfo(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {
      videoModel: 'doubao-seedance-1-5-pro-251215',
      duration: 5,
    }))
    expect(image).toMatchObject({ billable: true, apiType: 'image', quantity: 2 })
    expect(video).toMatchObject({ billable: true, apiType: 'video', quantity: 1 })
  })

  it.each(['comfyui::', 'comfyui:remote::wf-image', 'other::comfyui::wf-image']) (
    'does not grant zero billing to a malformed or non-native key %s',
    (model) => {
      expect(buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, { imageModel: model }))
        .toMatchObject({ billable: true })
    },
  )
})
