// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkflowCreationWizard from '@/app/[locale]/profile/components/comfyui/WorkflowCreationWizard'
import {
  analyzeWorkflowJson,
  createWorkflowDraft,
} from '@/app/[locale]/profile/components/comfyui/workflow-requests'
import { createWorkflowAnalysisCoordinator } from '@/app/[locale]/profile/components/comfyui/guided-workflow-creation'
import {
  WorkflowRequestError,
  type WorkflowAuthorDraft,
} from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import * as apiFetchModule from '@/lib/api-fetch'
import type {
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import enComfyui from '../../../messages/en/comfyui.json'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function analysis(overrides: Partial<WorkflowAutoMappingResult> = {}): WorkflowAutoMappingResult {
  return {
    graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } } },
    mediaType: 'image',
    purpose: 'generation',
    referenceCapacity: 1,
    issues: [],
    proposals: [{
      id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text',
      valueType: 'string', confidence: 'high', required: true,
      reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL', nodeTitle: 'Prompt',
    }],
    outputs: [{ name: 'result', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
    ...overrides,
  }
}

function ambiguousAnalysis(): WorkflowAutoMappingResult {
  return analysis({
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
      '2': { class_type: 'LoadImage', inputs: { image: 'source.png' } },
      '3': { class_type: 'LoadImage', inputs: { image: 'optional.png' } },
    },
    proposals: [
      {
        id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text',
        valueType: 'string', confidence: 'high', required: true,
        reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL', nodeTitle: 'Prompt',
      },
      {
        id: 'required-image', canonicalName: 'sourceImage', nodeId: '2', inputPath: 'image',
        valueType: 'image_ref', confidence: 'ambiguous', required: true,
        reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', nodeTitle: 'Required image',
      },
      {
        id: 'optional-image', canonicalName: 'referenceImages', nodeId: '3', inputPath: 'image',
        valueType: 'image_ref', confidence: 'ambiguous', required: false,
        reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', nodeTitle: 'Optional image',
      },
    ],
    outputs: [
      { name: 'resultA', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
      { name: 'resultB', nodeId: '10', fieldPath: 'images', mediaType: 'image', primary: false },
    ],
  })
}

function renderWizard(overrides: Partial<React.ComponentProps<typeof WorkflowCreationWizard>> = {}) {
  const props = {
    onCancel: vi.fn(),
    onCreate: vi.fn<(_: WorkflowAuthorDraft) => Promise<string>>().mockResolvedValue('workflow-1'),
    onCreated: vi.fn(),
    analyze: vi.fn().mockResolvedValue({ sourceText: '{}', analysis: analysis() }),
    ...overrides,
  }
  return {
    props,
    view: render(<NextIntlClientProvider
      locale="en"
      messages={{ comfyui: enComfyui }}
      timeZone="UTC"
    >
      <WorkflowCreationWizard {...props} />
    </NextIntlClientProvider>),
  }
}

function selectKindAndAdvance(
  view: ReturnType<typeof render>,
  title = 'Image generation',
) {
  fireEvent.click(view.getByRole('button', { name: new RegExp(title) }))
  fireEvent.click(view.getByRole('button', { name: 'Next' }))
}

function upload(view: ReturnType<typeof render>, filename: string, text = '{}') {
  const file = new File([text], filename, { type: 'application/json' })
  fireEvent.change(view.getByLabelText('Workflow JSON file'), { target: { files: [file] } })
  return file
}

describe('WorkflowCreationWizard', () => {
  it('uses the bounded scroll layout, styles the active step, and renders only that step', () => {
    const { view } = renderWizard()
    const root = view.container.querySelector('main') as HTMLElement
    const scroller = root.firstElementChild as HTMLElement
    const inner = scroller.firstElementChild as HTMLElement
    const activeStep = view.getByRole('listitem', { current: 'step' })

    expect(root.className).toBe('h-full min-h-0 min-w-0 overflow-hidden')
    expect(scroller.className).toBe('h-full min-w-0 overflow-y-auto overflow-x-hidden')
    expect(inner.className).toContain('mx-auto w-full max-w-[60rem] min-w-0 px-4 py-6 sm:px-6')
    expect(activeStep.className).toContain('border-[var(--glass-stroke-focus)]')
    expect(view.getByText('What kind of workflow are you creating?')).toBeTruthy()
    expect(view.queryByRole('heading', { name: 'Upload workflow' })).toBeNull()
    expect(view.queryByRole('heading', { name: 'Review and confirm' })).toBeNull()
    expect(view.container.innerHTML).not.toMatch(/(?:min-)?w-\[\d+px\]/)
  })

  it('creates an existing WorkflowAuthorDraft from the analyzed source and confirmed review', async () => {
    const analyze = vi.fn().mockResolvedValue({
      sourceText: '{\n  "original": true\n}',
      analysis: ambiguousAnalysis(),
    })
    const onCreate = vi.fn<(_: WorkflowAuthorDraft) => Promise<string>>().mockResolvedValue('created-id')
    const onCreated = vi.fn()
    const { view } = renderWizard({ analyze, onCreate, onCreated })

    selectKindAndAdvance(view, 'Image editing')
    await act(async () => { upload(view, 'portrait.v2.json') })

    expect(view.getByRole('heading', { name: 'Review and confirm' })).toBeTruthy()
    const name = view.getByRole('textbox', { name: 'Workflow name' })
    expect((name as HTMLInputElement).value).toBe('portrait.v2')
    fireEvent.change(name, { target: { value: 'Portrait Retouch' } })
    fireEvent.click(view.getByRole('radio', { name: 'Source image' }))
    fireEvent.click(view.getByRole('radio', { name: 'resultB' }))
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Create workflow' })) })

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Portrait Retouch',
      mediaType: 'image',
      purpose: 'generation',
      apiFormatJson: '{\n  "original": true\n}',
      variableDefinitions: [
        { name: 'prompt', type: 'string', required: true },
        { name: 'sourceImage', type: 'image_ref', required: true },
      ],
      bindings: [
        { nodeId: '1', inputPath: 'text', variable: 'prompt', valueType: 'string' },
        { nodeId: '2', inputPath: 'image', variable: 'sourceImage', valueType: 'image_ref' },
      ],
      outputs: [
        { name: 'resultA', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
        { name: 'resultB', nodeId: '10', fieldPath: 'images', mediaType: 'image', primary: true },
      ],
    })
    expect(onCreated).toHaveBeenCalledWith('created-id')
  })

  it('lets only the latest overlapping analysis render or create', async () => {
    const pendingA = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const pendingB = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const analyze = vi.fn((_kind: WorkflowImportKind, file: File) => file.name === 'a.json'
      ? pendingA.promise
      : pendingB.promise)
    const onCreate = vi.fn<(_: WorkflowAuthorDraft) => Promise<string>>().mockResolvedValue('workflow-b')
    const { view } = renderWizard({ analyze, onCreate })

    selectKindAndAdvance(view)
    upload(view, 'a.json')
    upload(view, 'b.json')
    expect(view.getByText('Analyzing workflow…')).toBeTruthy()
    expect(view.getByRole('region', { name: 'Upload workflow JSON' }).getAttribute('aria-busy')).toBe('true')
    expect((view.getByLabelText('Workflow JSON file') as HTMLInputElement).disabled).toBe(false)

    await act(async () => {
      pendingB.resolve({ sourceText: '{"graph":"B"}', analysis: analysis({
        outputs: [{ name: 'B result', nodeId: 'B', fieldPath: 'images', mediaType: 'image', primary: true }],
      }) })
      await pendingB.promise
    })
    expect((view.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('b')

    await act(async () => {
      pendingA.resolve({ sourceText: '{"graph":"A"}', analysis: analysis({
        outputs: [{ name: 'A result', nodeId: 'A', fieldPath: 'images', mediaType: 'image', primary: true }],
      }) })
      await pendingA.promise
    })
    expect((view.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('b')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Create workflow' })) })
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'b', apiFormatJson: '{"graph":"B"}',
      outputs: [expect.objectContaining({ nodeId: 'B', primary: true })],
    }))
  })

  it('blocks creation only for required ambiguity and an unresolved multiple output', async () => {
    const { view } = renderWizard({
      analyze: vi.fn().mockResolvedValue({ sourceText: '{}', analysis: ambiguousAnalysis() }),
    })
    selectKindAndAdvance(view, 'Image editing')
    await act(async () => { upload(view, 'edit.json') })

    const create = view.getByRole('button', { name: 'Create workflow' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(view.queryByText('Optional image')).toBeNull()
    fireEvent.click(view.getByRole('radio', { name: 'Source image' }))
    expect(create.disabled).toBe(true)
    fireEvent.click(view.getByRole('radio', { name: 'resultA' }))
    expect(create.disabled).toBe(false)
  })

  it('keeps creation blocked when analysis has no usable output', async () => {
    const { view } = renderWizard({
      analyze: vi.fn().mockResolvedValue({
        sourceText: '{}',
        analysis: analysis({ outputs: [], issues: [] }),
      }),
    })
    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'no-output.json') })

    expect((view.getByRole('button', { name: 'Create workflow' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('preserves the review after creation rejection and only shows a localized safe error', async () => {
    const onCreate = vi.fn<(_: WorkflowAuthorDraft) => Promise<string>>()
      .mockRejectedValueOnce(new Error('<html>private server body</html>'))
      .mockResolvedValueOnce('retry-id')
    const { view, props } = renderWizard({
      onCreate,
      analyze: vi.fn().mockResolvedValue({ sourceText: '{}', analysis: ambiguousAnalysis() }),
    })
    selectKindAndAdvance(view, 'Image editing')
    await act(async () => { upload(view, 'retry.json') })
    fireEvent.change(view.getByRole('textbox', { name: 'Workflow name' }), { target: { value: 'Retry Name' } })
    fireEvent.click(view.getByRole('radio', { name: 'Source image' }))
    fireEvent.click(view.getByRole('radio', { name: 'resultA' }))

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Create workflow' })) })
    expect(view.getByRole('alert').textContent).toBe('The workflow request failed.')
    expect(view.container.textContent).not.toContain('private server body')
    expect((view.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Retry Name')
    expect(view.getByText('The final output is selected and confirmed')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Retry creation' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry creation' })) })
    expect(onCreate).toHaveBeenCalledTimes(2)
    expect(onCreate.mock.calls[1]?.[0]).toEqual(onCreate.mock.calls[0]?.[0])
    expect(props.onCreated).toHaveBeenCalledWith('retry-id')
  })

  it('keeps type and proposed name after analysis rejection, then accepts a replacement file', async () => {
    const rejected = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const analyze = vi.fn()
      .mockReturnValueOnce(rejected.promise)
      .mockResolvedValueOnce({ sourceText: '{"replacement":true}', analysis: analysis() })
    const { view } = renderWizard({ analyze })
    selectKindAndAdvance(view, 'Image editing')
    upload(view, 'broken.json')

    await act(async () => {
      rejected.reject(new WorkflowRequestError('INVALID_PARAMS'))
      await rejected.promise.catch(() => undefined)
    })
    expect(view.getByRole('heading', { name: 'Upload workflow' })).toBeTruthy()
    expect((view.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('broken')
    expect(view.getByRole('alert').textContent).toBe('The workflow settings are invalid. Review the fields and try again.')

    await act(async () => { upload(view, 'replacement.json') })
    expect(view.getByRole('heading', { name: 'Review and confirm' })).toBeTruthy()
    expect((view.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('replacement')
    expect(view.queryByText('The workflow settings are invalid. Review the fields and try again.')).toBeNull()
  })

  it('cancels explicitly and invalidates late analysis on unmount', async () => {
    const pending = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const { view, props } = renderWizard({ analyze: vi.fn(() => pending.promise) })
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)

    selectKindAndAdvance(view)
    upload(view, 'late.json')
    view.unmount()
    await act(async () => {
      pending.resolve({ sourceText: '{}', analysis: analysis() })
      await pending.promise
    })
    expect(props.onCreate).not.toHaveBeenCalled()
    expect(props.onCreated).not.toHaveBeenCalled()

    const coordinator = createWorkflowAnalysisCoordinator()
    const ticket = coordinator.begin()
    coordinator.dispose()
    expect(coordinator.isCurrent(ticket)).toBe(false)
  })

  it('reactivates a disposed coordinator for Strict Mode effect replay', () => {
    const coordinator = createWorkflowAnalysisCoordinator()
    const staleTicket = coordinator.begin()
    coordinator.dispose()
    expect(coordinator.isCurrent(staleTicket)).toBe(false)

    coordinator.reset()
    const currentTicket = coordinator.begin()
    expect(coordinator.isCurrent(currentTicket)).toBe(true)
  })

  it('does not deliver a late creation result after unmount', async () => {
    const pendingCreate = deferred<string>()
    const onCreate = vi.fn(() => pendingCreate.promise)
    const onCreated = vi.fn()
    const { view } = renderWizard({ onCreate, onCreated })
    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'create-late.json') })
    fireEvent.click(view.getByRole('button', { name: 'Create workflow' }))
    expect(onCreate).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      pendingCreate.resolve('late-id')
      await pendingCreate.promise
    })

    expect(onCreated).not.toHaveBeenCalled()
  })

  it('clears answers when backing up and analyzing a different graph', async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce({ sourceText: '{"a":true}', analysis: ambiguousAnalysis() })
      .mockResolvedValueOnce({ sourceText: '{"b":true}', analysis: ambiguousAnalysis() })
    const { view } = renderWizard({ analyze })
    selectKindAndAdvance(view, 'Image editing')
    await act(async () => { upload(view, 'a.json') })
    fireEvent.click(view.getByRole('radio', { name: 'Source image' }))
    fireEvent.click(view.getByRole('radio', { name: 'resultB' }))
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    await act(async () => { upload(view, 'b.json') })

    expect((view.getByRole('radio', { name: 'Source image' }) as HTMLInputElement).checked).toBe(false)
    expect((view.getByRole('radio', { name: 'resultB' }) as HTMLInputElement).checked).toBe(false)
    expect((view.getByRole('button', { name: 'Create workflow' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('workflow request helpers', () => {
  it('analyzes the bounded original JSON with authenticated apiFetch', async () => {
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      analysis: analysis(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const file = new File(['{"1":{"class_type":"X","inputs":{}}}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{"1":{"class_type":"X","inputs":{}}}') })

    const result = await analyzeWorkflowJson('image_generation', file)

    expect(result.sourceText).toBe('{"1":{"class_type":"X","inputs":{}}}')
    expect(apiFetch).toHaveBeenCalledWith('/api/comfyui/workflows/analyze', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'image_generation', apiFormatJson: { '1': { class_type: 'X', inputs: {} } } }),
    }))
  })

  it('never parses or exposes a non-JSON error body', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response('<html>secret diagnostics</html>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    }))
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toMatchObject({
      name: 'WorkflowRequestError', code: 'UNKNOWN', message: 'workflowRequestFailed',
    })
  })

  it('rejects malformed success and network failures safely', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch')
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new Error('socket details'))
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toMatchObject({ code: 'UNKNOWN' })
    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toThrow('socket details')
  })

  it('rejects malformed nested analysis entries before the review can render them', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      analysis: {
        graph: {}, mediaType: 'image', purpose: 'generation', referenceCapacity: 0,
        proposals: [null], outputs: [], issues: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('creates a workflow payload and rejects a malformed created workflow safely', async () => {
    const draft: WorkflowAuthorDraft = {
      name: 'Portrait', mediaType: 'image', purpose: 'generation', apiFormatJson: '{}',
      variableDefinitions: [], bindings: [],
      outputs: [{ name: 'result', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
    }
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: { id: 'created-id' } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: {} }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))

    await expect(createWorkflowDraft(draft)).resolves.toBe('created-id')
    expect(apiFetch).toHaveBeenLastCalledWith('/api/comfyui/workflows', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'generation', apiFormatJson: {}, variableDefinitions: [], bindings: [], outputs: draft.outputs,
        name: 'Portrait', mediaType: 'image',
      }),
    }))
    await expect(createWorkflowDraft(draft)).rejects.toMatchObject({ code: 'UNKNOWN' })
  })
})
