import { describe, expect, it, vi } from 'vitest'

import {
  checkComfyCompatibility,
  type ComfyCompatibilityClient,
} from '@/lib/comfyui/compatibility'
import type { ComfyWorkflowRequirements } from '@/lib/comfyui/types'

const graph = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wanted.safetensors' } },
  '5': { class_type: 'KSampler', inputs: {} },
}

const requirements: ComfyWorkflowRequirements = {
  nodeClasses: ['CheckpointLoaderSimple', 'KSampler'],
  candidateLoaderInputs: [
    { nodeId: '4', inputName: 'ckpt_name', value: 'wanted.safetensors' },
  ],
}

function objectInfo(models = ['wanted.safetensors']) {
  return {
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: [models, { model_folder: 'checkpoints' }],
        },
      },
    },
    KSampler: { input: { required: {} } },
  }
}

function client(info: Record<string, unknown>): ComfyCompatibilityClient & {
  getObjectInfo: ReturnType<typeof vi.fn>
  getModels: ReturnType<typeof vi.fn>
} {
  return {
    getObjectInfo: vi.fn().mockResolvedValue(info),
    getModels: vi.fn().mockResolvedValue(['wanted.safetensors']),
  }
}

describe('checkComfyCompatibility', () => {
  it('returns exact sorted missing node and model requirements', async () => {
    const comfy = client({
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['other.safetensors'], { model_folder: 'checkpoints' }] } },
      },
    })

    await expect(checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy,
    })).resolves.toEqual({
      compatible: false,
      missingNodes: ['KSampler'],
      missingModels: [{ nodeId: '4', field: 'ckpt_name', value: 'wanted.safetensors' }],
      workflowHash: 'workflow-a',
      capabilityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(comfy.getModels).toHaveBeenCalledWith('checkpoints')
  })

  it('reports a complete match with exact empty missing arrays', async () => {
    const comfy = client(objectInfo())

    const result = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy,
    })

    expect(result.compatible).toBe(true)
    expect(result.missingNodes).toEqual([])
    expect(result.missingModels).toEqual([])
  })

  it('uses object_info enums as authority even when the model endpoint contains the value', async () => {
    const comfy = client(objectInfo(['other.safetensors']))
    comfy.getModels.mockResolvedValue(['wanted.safetensors'])

    const result = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy,
    })

    expect(result.missingModels).toEqual([
      { nodeId: '4', field: 'ckpt_name', value: 'wanted.safetensors' },
    ])
  })

  it('queries model folders only for enum fields explicitly identified by object_info', async () => {
    const comfy = client({
      CheckpointLoaderSimple: {
        input: {
          required: {
            ckpt_name: [['wanted.safetensors'], { model_folder: 'checkpoints' }],
            prompt: [['one', 'two'], {}],
          },
        },
      },
      KSampler: { input: { required: {} } },
    })

    await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy,
    })

    expect(comfy.getModels).toHaveBeenCalledTimes(1)
    expect(comfy.getModels).toHaveBeenCalledWith('checkpoints')
  })

  it('invalidates the connection/workflow cache when the capability fingerprint changes', async () => {
    const comfy = client(objectInfo())
    const cache = new Map()

    const first = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy, cache,
    })
    comfy.getObjectInfo.mockResolvedValue(objectInfo(['other.safetensors']))
    const second = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-a', graph, requirements, client: comfy, cache,
    })

    expect(first.compatible).toBe(true)
    expect(second.compatible).toBe(false)
    expect(second.capabilityFingerprint).not.toBe(first.capabilityFingerprint)
    expect([...cache.keys()]).toEqual([
      `connection-1:workflow-a:${second.capabilityFingerprint}`,
    ])
  })

  it('binds a candidate node to its own class instead of another class with the same field', async () => {
    const comfy = client({
      LoaderA: {
        input: { required: { model_name: [['wanted.safetensors'], { model_folder: 'a' }] } },
      },
      LoaderB: {
        input: { required: { model_name: [['other.safetensors'], { model_folder: 'b' }] } },
      },
    })
    const sharedFieldRequirements: ComfyWorkflowRequirements = {
      nodeClasses: ['LoaderA', 'LoaderB'],
      candidateLoaderInputs: [
        { nodeId: '20', inputName: 'model_name', value: 'wanted.safetensors' },
      ],
    }

    const missing = await checkComfyCompatibility({
      connectionId: 'connection-1',
      workflowHash: 'workflow-b',
      graph: {
        '10': { class_type: 'LoaderA', inputs: { model_name: 'wanted.safetensors' } },
        '20': { class_type: 'LoaderB', inputs: { model_name: 'wanted.safetensors' } },
      },
      requirements: sharedFieldRequirements,
      client: comfy,
    })
    const complete = await checkComfyCompatibility({
      connectionId: 'connection-1',
      workflowHash: 'workflow-c',
      graph: {
        '10': { class_type: 'LoaderB', inputs: { model_name: 'other.safetensors' } },
        '20': { class_type: 'LoaderA', inputs: { model_name: 'wanted.safetensors' } },
      },
      requirements: sharedFieldRequirements,
      client: comfy,
    })

    expect(missing.missingModels).toEqual([
      { nodeId: '20', field: 'model_name', value: 'wanted.safetensors' },
    ])
    expect(complete.missingModels).toEqual([])
    expect(complete.compatible).toBe(true)
  })
})
