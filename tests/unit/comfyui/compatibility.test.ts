import { describe, expect, it, vi } from 'vitest'

import {
  checkComfyCompatibility,
  MAX_COMFY_COMPATIBILITY_CANDIDATES,
  MAX_COMFY_MODEL_FOLDERS,
  MAX_COMFY_MODEL_PROBE_CONCURRENCY,
  MAX_COMFY_ENUM_ENTRIES,
  MAX_COMFY_ENUM_VALUE_BYTES,
  MAX_COMFY_TOTAL_ENUM_BYTES,
  MAX_COMFY_TOTAL_ENUM_VALUES,
  parseComfyInputEnum,
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

  it.each([
    ['ordinary STRING', ['STRING', { multiline: true }]],
    ['empty enum', [[], { model_folder: 'empty' }]],
    ['malformed schema', { type: 'MODEL' }],
    ['missing field', undefined],
  ])('does not misreport %s inputs as missing models', async (_label, fieldSchema) => {
    const required = fieldSchema === undefined ? {} : { model_name: fieldSchema }
    const comfy = client({ Loader: { input: { required } } })

    const result = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'workflow-schema',
      graph: { '1': { class_type: 'Loader', inputs: { model_name: 'wanted' } } },
      requirements: {
        nodeClasses: ['Loader'],
        candidateLoaderInputs: [{ nodeId: '1', inputName: 'model_name', value: 'wanted' }],
      },
      client: comfy,
    })

    expect(result.missingModels).toEqual([])
    expect(comfy.getModels).not.toHaveBeenCalled()
  })

  it('fails closed before probing when candidate or identified folder limits are exceeded', async () => {
    const comfy = client({})
    const tooManyCandidates = Array.from(
      { length: MAX_COMFY_COMPATIBILITY_CANDIDATES + 1 },
      (_, index) => ({ nodeId: String(index), inputName: 'model', value: 'wanted' }),
    )
    await expect(checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'too-many-candidates', graph: {},
      requirements: { nodeClasses: [], candidateLoaderInputs: tooManyCandidates }, client: comfy,
    })).rejects.toMatchObject({ code: 'COMFY_WORKFLOW_INCOMPATIBLE' })
    expect(comfy.getObjectInfo).not.toHaveBeenCalled()

    const folderCount = MAX_COMFY_MODEL_FOLDERS + 1
    const info: Record<string, unknown> = {}
    const folderGraph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
    const folderCandidates = Array.from({ length: folderCount }, (_, index) => {
      const nodeId = String(index)
      const classType = `Loader${index}`
      info[classType] = {
        input: { required: { model: [['wanted'], { model_folder: `folder-${index}` }] } },
      }
      folderGraph[nodeId] = { class_type: classType, inputs: { model: 'wanted' } }
      return { nodeId, inputName: 'model', value: 'wanted' }
    })
    comfy.getObjectInfo.mockResolvedValue(info)
    await expect(checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'too-many-folders', graph: folderGraph,
      requirements: {
        nodeClasses: Object.keys(info), candidateLoaderInputs: folderCandidates,
      },
      client: comfy,
    })).rejects.toMatchObject({ code: 'COMFY_WORKFLOW_INCOMPATIBLE' })
    expect(comfy.getModels).not.toHaveBeenCalled()
  })

  it('bounds model folder probe concurrency and rejects malformed model catalogs', async () => {
    const folderCount = MAX_COMFY_MODEL_PROBE_CONCURRENCY + 2
    const info: Record<string, unknown> = {}
    const folderGraph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
    const folderCandidates = Array.from({ length: folderCount }, (_, index) => {
      const nodeId = String(index)
      const classType = `Loader${index}`
      info[classType] = {
        input: { required: { model: [['wanted'], { model_folder: `folder-${index}` }] } },
      }
      folderGraph[nodeId] = { class_type: classType, inputs: { model: 'wanted' } }
      return { nodeId, inputName: 'model', value: 'wanted' }
    })
    const comfy = client(info)
    let active = 0
    let peak = 0
    comfy.getModels.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return ['wanted']
    })

    await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'bounded-folders', graph: folderGraph,
      requirements: { nodeClasses: Object.keys(info), candidateLoaderInputs: folderCandidates },
      client: comfy,
    })
    expect(peak).toBeLessThanOrEqual(MAX_COMFY_MODEL_PROBE_CONCURRENCY)

    comfy.getModels.mockResolvedValue({ secret: 'not-an-array' })
    await expect(checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'malformed-catalog', graph: folderGraph,
      requirements: { nodeClasses: Object.keys(info), candidateLoaderInputs: folderCandidates },
      client: comfy,
    })).rejects.toMatchObject({ code: 'COMFY_WORKFLOW_INCOMPATIBLE' })
  })

  it('parses and normalizes one shared class/input enum once for 256 candidates', async () => {
    const values = Array.from({ length: 2_000 }, (_, index) => `model-${index}`)
    const comfy = client({
      Loader: { input: { required: { model: [values, { model_folder: 'models' }] } } },
    })
    const parser = vi.fn(parseComfyInputEnum)
    const candidates = Array.from(
      { length: MAX_COMFY_COMPATIBILITY_CANDIDATES },
      (_, index) => ({ nodeId: String(index), inputName: 'model', value: `model-${index}` }),
    )
    const sharedGraph = Object.fromEntries(candidates.map(({ nodeId, value }) => [
      nodeId, { class_type: 'Loader', inputs: { model: value } },
    ]))

    const result = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'shared-enum', graph: sharedGraph,
      requirements: { nodeClasses: ['Loader'], candidateLoaderInputs: candidates },
      client: comfy, parseInputEnum: parser,
    })

    expect(result.compatible).toBe(true)
    expect(parser).toHaveBeenCalledTimes(1)
  })

  it('keeps class and input identity distinct when delimiter-based keys would collide', async () => {
    const firstClass = 'a\u0000b'
    const firstInput = 'c'
    const secondClass = 'a'
    const secondInput = 'b\u0000c'
    const comfy = client({
      [firstClass]: { input: { required: { [firstInput]: [['wanted'], {}] } } },
      [secondClass]: { input: { required: { [secondInput]: [['other'], {}] } } },
    })

    const result = await checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'collision',
      graph: {
        '1': { class_type: firstClass, inputs: { [firstInput]: 'wanted' } },
        '2': { class_type: secondClass, inputs: { [secondInput]: 'wanted' } },
      },
      requirements: {
        nodeClasses: [firstClass, secondClass],
        candidateLoaderInputs: [
          { nodeId: '1', inputName: firstInput, value: 'wanted' },
          { nodeId: '2', inputName: secondInput, value: 'wanted' },
        ],
      },
      client: comfy,
    })

    expect(result.missingModels).toEqual([
      { nodeId: '2', field: secondInput, value: 'wanted' },
    ])
  })

  it.each([
    [
      'entry count',
      Array.from({ length: MAX_COMFY_ENUM_ENTRIES + 1 }, (_, index) => `m${index}`),
    ],
    ['single value bytes', ['x'.repeat(MAX_COMFY_ENUM_VALUE_BYTES + 1)]],
    ['mixed invalid values', ['valid', 42]],
  ])('fails closed on oversized or malformed %s enums', async (_label, values) => {
    const comfy = client({
      Loader: { input: { required: { model: [values, { model_folder: 'models' }] } } },
    })
    await expect(checkComfyCompatibility({
      connectionId: 'connection-1', workflowHash: 'bad-enum',
      graph: { '1': { class_type: 'Loader', inputs: { model: 'wanted' } } },
      requirements: {
        nodeClasses: ['Loader'],
        candidateLoaderInputs: [{ nodeId: '1', inputName: 'model', value: 'wanted' }],
      },
      client: comfy,
    })).rejects.toMatchObject({ code: 'COMFY_WORKFLOW_INCOMPATIBLE' })
    expect(comfy.getModels).not.toHaveBeenCalled()
  })

  it('fails closed when unique enum aggregate value or byte budgets are exceeded', async () => {
    const valueOverflow = Array.from(
      { length: MAX_COMFY_TOTAL_ENUM_VALUES + 1 },
      (_, index) => `m${index}`,
    )
    const byteValue = 'x'.repeat(MAX_COMFY_ENUM_VALUE_BYTES)
    const byteOverflow = Array.from(
      { length: Math.floor(MAX_COMFY_TOTAL_ENUM_BYTES / Buffer.byteLength(byteValue)) + 1 },
      (_, index) => `${String(index).padStart(6, '0')}${byteValue.slice(6)}`,
    )
    for (const values of [valueOverflow, byteOverflow]) {
      const comfy = client({ Loader: { input: { required: { model: [values, {}] } } } })
      await expect(checkComfyCompatibility({
        connectionId: 'connection-1', workflowHash: 'aggregate-overflow',
        graph: { '1': { class_type: 'Loader', inputs: { model: 'wanted' } } },
        requirements: {
          nodeClasses: ['Loader'],
          candidateLoaderInputs: [{ nodeId: '1', inputName: 'model', value: 'wanted' }],
        },
        client: comfy,
      })).rejects.toMatchObject({ code: 'COMFY_WORKFLOW_INCOMPATIBLE' })
    }
  })
})
