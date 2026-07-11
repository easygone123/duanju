import { describe, expect, it } from 'vitest'
import {
  resolveImageTaskSnapshot,
  resolveVideoTaskSnapshot,
} from '@/lib/workers/task-model-snapshot'

describe('queued task model snapshots', () => {
  it.each([
    ['image', resolveImageTaskSnapshot, 'imageModel'],
    ['video', resolveVideoTaskSnapshot, 'videoModel'],
  ] as const)('keeps the queued %s model/version when legacy config later changes', (_kind, resolve, field) => {
    const snapshot = resolve({
      [field]: 'comfyui::workflow-a',
      comfyWorkflowVersionId: 'version-a-1',
      comfyModelSnapshotVersion: 1,
    }, {
      model: 'comfyui::workflow-b',
      comfyWorkflowVersionId: 'version-b-2',
    })

    expect(snapshot).toEqual({
      model: 'comfyui::workflow-a',
      comfyWorkflowVersionId: 'version-a-1',
    })
  })

  it.each([
    ['marked Comfy snapshot without version', {
      imageModel: 'comfyui::workflow-a', comfyModelSnapshotVersion: 1,
    }],
    ['unknown snapshot marker', {
      imageModel: 'comfyui::workflow-a',
      comfyWorkflowVersionId: 'version-a-1',
      comfyModelSnapshotVersion: 2,
    }],
    ['version without snapshot model', { comfyWorkflowVersionId: 'version-a-1' }],
    ['cloud snapshot carrying Comfy version', {
      imageModel: 'cloud::image-model', comfyWorkflowVersionId: 'version-a-1',
    }],
    ['malformed snapshot model', { imageModel: 'legacy-model-id' }],
  ])('fails closed for %s', (_case, payload) => {
    expect(() => resolveImageTaskSnapshot(payload, {
      model: 'comfyui::workflow-b', comfyWorkflowVersionId: 'version-b-2',
    })).toThrow('TASK_MODEL_SNAPSHOT_INVALID')
  })

  it('backfills an unmarked legacy Comfy model only from the same trusted current selection', () => {
    expect(resolveImageTaskSnapshot({ imageModel: 'comfyui::workflow-a' }, {
      model: 'comfyui::workflow-a', comfyWorkflowVersionId: 'version-a-1',
    })).toEqual({
      model: 'comfyui::workflow-a', comfyWorkflowVersionId: 'version-a-1',
    })
  })

  it('rejects an unmarked legacy Comfy model after the trusted current selection changed', () => {
    expect(() => resolveImageTaskSnapshot({ imageModel: 'comfyui::workflow-a' }, {
      model: 'comfyui::workflow-b', comfyWorkflowVersionId: 'version-b-2',
    })).toThrow('TASK_MODEL_SNAPSHOT_INVALID')
  })

  it('uses current config only for a legacy image task with no snapshot fields', () => {
    expect(resolveImageTaskSnapshot({ candidateCount: 1 }, {
      model: 'comfyui::workflow-b', comfyWorkflowVersionId: 'version-b-2',
    })).toEqual({
      model: 'comfyui::workflow-b', comfyWorkflowVersionId: 'version-b-2',
    })
  })

  it('accepts a non-Comfy snapshot without a workflow version', () => {
    expect(resolveImageTaskSnapshot({ imageModel: 'cloud::image-model' }, {
      model: 'comfyui::workflow-b', comfyWorkflowVersionId: 'version-b-2',
    })).toEqual({ model: 'cloud::image-model', comfyWorkflowVersionId: undefined })
  })

})
