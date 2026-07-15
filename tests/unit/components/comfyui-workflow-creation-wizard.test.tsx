// @vitest-environment jsdom

import React, { StrictMode } from 'react'
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
  safeWorkflowAnalysisErrorKey,
  safeWorkflowErrorKey,
  workflowRequestErrorFromPayload,
  WorkflowRequestError,
  type WorkflowAuthorDraft,
} from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import * as apiFetchModule from '@/lib/api-fetch'
import type {
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { analyzeComfyApiWorkflow } from '@/lib/comfyui/workflow-auto-mapper'
import { validateWorkflowContract } from '@/lib/comfyui/workflow-schema'
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
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
      '2': { class_type: 'LoadImage', inputs: { image: 'source.png' } },
      '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      '10': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
    },
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
      '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      '10': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
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

function renderWizard(
  overrides: Partial<React.ComponentProps<typeof WorkflowCreationWizard>> = {},
  strict = false,
) {
  const props = {
    onCancel: vi.fn(),
    onCreate: vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
      .mockResolvedValue('workflow-1'),
    onCreated: vi.fn(),
    analyze: vi.fn().mockResolvedValue({ sourceText: '{}', analysis: analysis() }),
    ...overrides,
  }
  const wizard = <NextIntlClientProvider
      locale="en"
      messages={{ comfyui: enComfyui }}
      timeZone="UTC"
    >
      <WorkflowCreationWizard {...props} />
    </NextIntlClientProvider>
  return {
    props,
    view: render(strict ? <StrictMode>{wizard}</StrictMode> : wizard),
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
    const root = view.getByRole('region', { name: 'Create a ComfyUI workflow' })
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

  it('names the wizard region, focuses each stage heading, and uses only one live-region mechanism', async () => {
    const { view } = renderWizard()
    expect(view.getByRole('region', { name: 'Create a ComfyUI workflow' })).toBeTruthy()
    expect(view.queryByRole('main', { name: 'Create a ComfyUI workflow' })).toBeNull()
    expect(view.getByRole('heading', { name: 'Choose type' })).toBe(document.activeElement)

    selectKindAndAdvance(view)
    expect(view.getByRole('heading', { name: 'Upload workflow' })).toBe(document.activeElement)
    await act(async () => { upload(view, 'focused-review.json') })
    expect(view.getByRole('heading', { name: 'Review and confirm' })).toBe(document.activeElement)

    expect(view.getByRole('status').getAttribute('aria-live')).toBeNull()
  })

  it('creates an existing WorkflowAuthorDraft from the analyzed source and confirmed review', async () => {
    const analyzed = ambiguousAnalysis()
    const sourceText = JSON.stringify(analyzed.graph, null, 2)
    const analyze = vi.fn().mockResolvedValue({
      sourceText,
      analysis: analyzed,
    })
    const onCreate = vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
      .mockResolvedValue('created-id')
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
      apiFormatJson: sourceText,
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
    }, expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i))
    const createdDraft = onCreate.mock.calls[0]![0]
    expect(validateWorkflowContract({
      graph: JSON.parse(createdDraft.apiFormatJson),
      purpose: createdDraft.purpose,
      variableDefinitions: createdDraft.variableDefinitions,
      bindings: createdDraft.bindings,
      outputs: createdDraft.outputs,
    })).toEqual([])
    expect(onCreated).toHaveBeenCalledWith('created-id')
  })

  it('lets only the latest overlapping analysis render or create', async () => {
    const pendingA = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const pendingB = deferred<{ sourceText: string; analysis: WorkflowAutoMappingResult }>()
    const analyze = vi.fn((_kind: WorkflowImportKind, file: File) => file.name === 'a.json'
      ? pendingA.promise
      : pendingB.promise)
    const onCreate = vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
      .mockResolvedValue('workflow-b')
    const { view } = renderWizard({ analyze, onCreate })

    selectKindAndAdvance(view)
    upload(view, 'a.json')
    upload(view, 'b.json')
    expect(view.getByText('Analyzing workflow…')).toBeTruthy()
    expect(view.getAllByRole('status')).toHaveLength(1)
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
    }), expect.any(String))
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
    const onCreate = vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
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
    expect(onCreate.mock.calls[1]?.[1]).toBe(onCreate.mock.calls[0]?.[1])
    expect(props.onCreated).toHaveBeenCalledWith('retry-id')
  })

  it('guards creation synchronously when two submit events occur in one render batch', async () => {
    const pendingCreate = deferred<string>()
    const onCreate = vi.fn(() => pendingCreate.promise)
    const { view } = renderWizard({ onCreate })
    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'single-submit.json') })

    const create = view.getByRole('button', { name: 'Create workflow' })
    act(() => {
      fireEvent.click(create)
      fireEvent.click(create)
    })

    expect(onCreate).toHaveBeenCalledTimes(1)
    await act(async () => {
      pendingCreate.resolve('created-once')
      await pendingCreate.promise
    })
  })

  it('retries rejected async navigation without posting the completed workflow again', async () => {
    const onCreate = vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
      .mockResolvedValue('created-id')
    const onCreated = vi.fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('consumer navigation failed'))
      .mockResolvedValueOnce(undefined)
    const { view } = renderWizard({ onCreate, onCreated })
    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'completed.json') })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Create workflow' }))
    })

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith('created-id')
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.queryByRole('button', { name: 'Retry creation' })).toBeNull()
    expect(view.getByRole('status').textContent).toBe('Workflow created.')
    expect((view.getByRole('button', { name: 'Create workflow' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Return to workflow library' }))
    })
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledTimes(2)
    expect(onCreated).toHaveBeenLastCalledWith('created-id')
  })

  it('offers the same navigation recovery when the success callback throws synchronously', async () => {
    const onCreate = vi.fn<(_: WorkflowAuthorDraft, creationId: string) => Promise<string>>()
      .mockResolvedValue('created-id')
    const onCreated = vi.fn(() => { throw new Error('consumer navigation failed') })
    const { view } = renderWizard({ onCreate, onCreated })
    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'completed-sync.json') })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Create workflow' }))
    })

    expect(view.getByRole('button', { name: 'Return to workflow library' })).toBeTruthy()
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith('created-id')
  })

  it('disables every mapping and output control while creation is pending', async () => {
    const pendingCreate = deferred<string>()
    const { view } = renderWizard({
      onCreate: vi.fn(() => pendingCreate.promise),
      analyze: vi.fn().mockResolvedValue({ sourceText: '{}', analysis: ambiguousAnalysis() }),
    })
    selectKindAndAdvance(view, 'Image editing')
    await act(async () => { upload(view, 'locked-review.json') })
    fireEvent.click(view.getByRole('radio', { name: 'Source image' }))
    fireEvent.click(view.getByRole('radio', { name: 'resultA' }))
    const advanced = view.getByText('Advanced Settings').closest('details') as HTMLDetailsElement
    advanced.open = true
    fireEvent(advanced, new Event('toggle'))

    fireEvent.click(view.getByRole('button', { name: 'Create workflow' }))

    expect(view.getAllByRole('radio').every((control) => (control as HTMLInputElement).disabled)).toBe(true)
    expect(view.getAllByRole('combobox').every((control) => (control as HTMLSelectElement).disabled)).toBe(true)

    await act(async () => {
      pendingCreate.resolve('created-id')
      await pendingCreate.promise
    })
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

  it('aborts analysis on replacement, cancel, back, and unmount without surfacing an error', async () => {
    const signals: AbortSignal[] = []
    const analyze = vi.fn((
      _kind: WorkflowImportKind,
      _file: File,
      signal?: AbortSignal,
    ) => {
      if (signal) signals.push(signal)
      return new Promise<{ sourceText: string; analysis: WorkflowAutoMappingResult }>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    const { view, props } = renderWizard({ analyze })
    selectKindAndAdvance(view)

    upload(view, 'first.json')
    upload(view, 'replacement.json')
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)

    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(signals[1]?.aborted).toBe(true)

    upload(view, 'back.json')
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    expect(signals[2]?.aborted).toBe(true)

    selectKindAndAdvance(view)
    upload(view, 'unmount.json')
    view.unmount()
    expect(signals[3]?.aborted).toBe(true)
    await act(async () => { await Promise.resolve() })
    expect(view.queryByRole('alert')).toBeNull()
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

  it('analyzes and reaches review under real Strict Mode effect replay', async () => {
    const analyze = vi.fn().mockResolvedValue({ sourceText: '{}', analysis: analysis() })
    const { view } = renderWizard({ analyze }, true)

    selectKindAndAdvance(view)
    await act(async () => { upload(view, 'strict.json') })

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(view.getByRole('heading', { name: 'Review and confirm' })).toBeTruthy()
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

  it('keeps a malformed successful analysis response out of wizard state', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      analysis: { ...analysis(), graph: { '1': null } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const { view } = renderWizard({ analyze: undefined })
    selectKindAndAdvance(view)
    const file = new File(['{}'], 'malformed.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    await act(async () => {
      fireEvent.change(view.getByLabelText('Workflow JSON file'), { target: { files: [file] } })
    })

    expect(view.getByRole('heading', { name: 'Upload workflow' })).toBeTruthy()
    expect(view.queryByRole('heading', { name: 'Review and confirm' })).toBeNull()
    expect(view.getByRole('alert').textContent).toBe('The workflow request failed.')
  })

  it('renders a localized API Format instruction without leaking server details', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'INVALID_PARAMS',
        message: '<script>private analyzer detail</script>',
        details: { reason: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED' },
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const { view } = renderWizard({ analyze: undefined })
    selectKindAndAdvance(view)
    const sourceText = JSON.stringify({ nodes: [], links: [] })
    const file = new File([sourceText], 'ui-workflow.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(sourceText) })

    await act(async () => {
      fireEvent.change(view.getByLabelText('Workflow JSON file'), { target: { files: [file] } })
    })

    const alert = view.getByRole('alert')
    expect(alert.textContent).toBe(
      'Export the workflow from ComfyUI in API Format, then upload that JSON file.',
    )
    expect(alert.textContent).not.toContain('The workflow settings are invalid')
    expect(alert.textContent).not.toContain('private analyzer detail')
  })
})

describe('workflow request helpers', () => {
  it('analyzes the bounded original JSON with authenticated apiFetch', async () => {
    const graph = analysis().graph
    const expectedAnalysis = analyzeComfyApiWorkflow({ graph, kind: 'image_generation' })
    const sourceText = JSON.stringify(graph)
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      analysis: expectedAnalysis,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const file = new File([sourceText], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(sourceText) })

    const result = await analyzeWorkflowJson('image_generation', file)

    expect(result.sourceText).toBe(sourceText)
    expect(apiFetch).toHaveBeenCalledWith('/api/comfyui/workflows/analyze', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'image_generation', apiFormatJson: graph }),
    }))
  })

  it('normalizes a wrapped upload while retaining strengthened response validation', async () => {
    const graph = analysis().graph
    const expectedAnalysis = analyzeComfyApiWorkflow({ graph, kind: 'image_generation' })
    const wrapped = { prompt: graph }
    const sourceText = JSON.stringify(wrapped)
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        analysis: expectedAnalysis,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        analysis: analysis({
          graph: { ...graph, extra: { class_type: 'SaveImage', inputs: {} } },
        }),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const file = new File([sourceText], 'wrapped.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(sourceText) })

    const result = await analyzeWorkflowJson('image_generation', file)

    expect(JSON.parse(result.sourceText)).toEqual(graph)
    expect(result.analysis.graph).toEqual(graph)
    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toMatchObject({
      name: 'WorkflowRequestError', code: 'UNKNOWN',
    })
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing', (proposal: WorkflowAutoMappingResult['proposals'][number]) => {
      const withoutTransform = { ...proposal }
      delete withoutTransform.transform
      return withoutTransform
    }],
    ['changed', (proposal: WorkflowAutoMappingResult['proposals'][number]) => ({
      ...proposal, transform: 'image_ref' as const,
    })],
  ])('rejects a successful analysis with a %s deterministic transform', async (_name, mutate) => {
    const graph = {
      '1': {
        class_type: 'LoadImage', inputs: { image: 'input.png' }, _meta: { title: 'Source Image' },
      },
      '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    }
    const expected = analyzeComfyApiWorkflow({ graph, kind: 'image_edit' })
    const proposalIndex = expected.proposals.findIndex((proposal) => proposal.transform === 'filename')
    expect(proposalIndex).toBeGreaterThanOrEqual(0)
    const mutated = {
      ...expected,
      proposals: expected.proposals.map((proposal, index) => (
        index === proposalIndex ? mutate(proposal) : proposal
      )),
    }
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(new Response(JSON.stringify({
      analysis: mutated,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const sourceText = JSON.stringify(graph)
    const file = new File([sourceText], 'image-edit.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(sourceText) })

    await expect(analyzeWorkflowJson('image_edit', file)).rejects.toMatchObject({
      name: 'WorkflowRequestError', code: 'UNKNOWN',
    })
  })

  it('retains only allowlisted stable analysis reasons and safely maps unknown reasons', () => {
    const known = workflowRequestErrorFromPayload({
      error: {
        code: 'INVALID_PARAMS',
        details: { reason: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED' },
      },
    })
    const unknown = workflowRequestErrorFromPayload({
      error: {
        code: 'INVALID_PARAMS',
        message: '<script>private diagnostic</script>',
        details: { reason: 'PRIVATE_SERVER_REASON' },
      },
    })

    expect(known).toMatchObject({
      code: 'INVALID_PARAMS', reason: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED',
    })
    expect(safeWorkflowAnalysisErrorKey(known))
      .toBe('guided.issues.COMFY_WORKFLOW_API_FORMAT_REQUIRED')
    expect(unknown).toMatchObject({ code: 'INVALID_PARAMS', reason: undefined })
    expect(safeWorkflowAnalysisErrorKey(unknown)).toBe('workflowRequestInvalid')
    expect(String(unknown)).not.toContain('private diagnostic')
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE_SERVER_REASON')
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

  it('maps analyze network failures to a typed safe error without raw details', async () => {
    vi.spyOn(apiFetchModule, 'apiFetch')
      .mockRejectedValueOnce(new Error('socket details'))
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    const error = await analyzeWorkflowJson('image_generation', file).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(WorkflowRequestError)
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', message: 'workflowRequestFailed' })
    expect(safeWorkflowErrorKey(error)).toBe('workflowNetworkFailed')
    expect(String(error)).not.toContain('socket details')
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it('passes the analysis abort signal through and preserves AbortError', async () => {
    const abortError = new DOMException('Aborted', 'AbortError')
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch').mockRejectedValue(abortError)
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })
    const controller = new AbortController()

    await expect(analyzeWorkflowJson('image_generation', file, controller.signal)).rejects.toBe(abortError)
    expect(apiFetch).toHaveBeenCalledWith('/api/comfyui/workflows/analyze', expect.objectContaining({
      signal: controller.signal,
    }))
  })

  it('does not mask client file parse errors as network failures', async () => {
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{invalid') })

    await expect(analyzeWorkflowJson('image_generation', file)).rejects.toThrow('workflowInvalidJson')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('rejects table-driven malformed successful analysis payloads', async () => {
    const base = analysis()
    const proposal = base.proposals[0]!
    const output = base.outputs[0]!
    const malformedCases: Array<[string, unknown]> = [
      ['array graph', { ...base, graph: [] }],
      ['empty graph key', { ...base, graph: { '': { class_type: 'X', inputs: {} } } }],
      ['whitespace graph key', { ...base, graph: { '   ': { class_type: 'X', inputs: {} } } }],
      ['padded graph key', { ...base, graph: { ' 1 ': { class_type: 'X', inputs: {} } } }],
      ['invalid graph node', { ...base, graph: { '1': null } }],
      ['blank graph class', { ...base, graph: { '1': { class_type: ' ', inputs: {} } } }],
      ['array graph inputs', { ...base, graph: { '1': { class_type: 'X', inputs: [] } } }],
      ['invalid proposal entry', { ...base, proposals: [null] }],
      ['blank proposal id', { ...base, proposals: [{ ...proposal, id: ' ' }] }],
      ['blank proposal node', { ...base, proposals: [{ ...proposal, nodeId: '' }] }],
      ['blank proposal path', { ...base, proposals: [{ ...proposal, inputPath: ' ' }] }],
      ['blank proposal reason', { ...base, proposals: [{ ...proposal, reasonCode: '' }] }],
      ['invalid proposal canonical enum', { ...base, proposals: [{ ...proposal, canonicalName: 'style' }] }],
      ['invalid proposal value enum', { ...base, proposals: [{ ...proposal, valueType: 'json' }] }],
      ['invalid proposal confidence enum', { ...base, proposals: [{ ...proposal, confidence: 'maybe' }] }],
      ['invalid proposal boolean', { ...base, proposals: [{ ...proposal, required: 'yes' }] }],
      ['invalid optional transform', { ...base, proposals: [{ ...proposal, transform: 'basename' }] }],
      ['negative optional index', { ...base, proposals: [{ ...proposal, referenceIndex: -1 }] }],
      ['fractional optional index', { ...base, proposals: [{ ...proposal, referenceIndex: 1.5 }] }],
      ['invalid optional title', { ...base, proposals: [{ ...proposal, nodeTitle: 7 }] }],
      ['invalid output entry', { ...base, outputs: [null] }],
      ['blank output name', { ...base, outputs: [{ ...output, name: ' ' }] }],
      ['blank output node', { ...base, outputs: [{ ...output, nodeId: '' }] }],
      ['blank output path', { ...base, outputs: [{ ...output, fieldPath: ' ' }] }],
      ['invalid output enum', { ...base, outputs: [{ ...output, mediaType: 'audio' }] }],
      ['invalid output boolean', { ...base, outputs: [{ ...output, primary: 1 }] }],
      ['invalid issue entry', { ...base, issues: [null] }],
      ['blank issue code', { ...base, issues: [{ code: '', message: 'invalid' }] }],
      ['blank issue message', { ...base, issues: [{ code: 'INVALID', message: ' ' }] }],
      ['invalid issue path', { ...base, issues: [{ code: 'INVALID', message: 'invalid', path: 1 }] }],
      ['negative reference capacity', { ...base, referenceCapacity: -1 }],
      ['fractional reference capacity', { ...base, referenceCapacity: 1.5 }],
      ['invalid media type', { ...base, mediaType: 'audio' }],
      ['invalid purpose', { ...base, purpose: 'editing' }],
    ]
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')
    const file = new File(['{}'], 'graph.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') })

    for (const [name, malformed] of malformedCases) {
      apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ analysis: malformed }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      const error = await analyzeWorkflowJson('image_generation', file).catch((reason: unknown) => reason)
      expect(error, name).toMatchObject({ name: 'WorkflowRequestError', code: 'UNKNOWN' })
    }
  })

  it('rejects successful analyses that violate shared graph or cross-field invariants', async () => {
    const base = analysis()
    const proposal = base.proposals[0]!
    const output = base.outputs[0]!
    const secondOutput = {
      name: 'preview', nodeId: '10', fieldPath: 'images', mediaType: 'image' as const, primary: false,
    }
    const invalidGraph = {
      ...base.graph,
      '9': { class_type: 'SaveImage', inputs: { images: ['missing-node', 0] } },
    }
    const cases: Array<[string, WorkflowAutoMappingResult, unknown?]> = [
      ['kind media mismatch', { ...base, mediaType: 'video' }],
      ['kind purpose mismatch', { ...base, purpose: 'upscale' }],
      ['returned graph mismatch', { ...base, graph: { ...base.graph, extra: { class_type: 'X', inputs: {} } } }],
      ['shared graph invalid', { ...base, graph: invalidGraph }, invalidGraph],
      ['proposal node missing', { ...base, proposals: [{ ...proposal, nodeId: 'missing-node' }] }],
      ['proposal path unsafe', { ...base, proposals: [{ ...proposal, inputPath: 'constructor.value' }] }],
      ['proposal path missing', { ...base, proposals: [{ ...proposal, inputPath: 'missing' }] }],
      ['duplicate proposal id', { ...base, proposals: [proposal, {
        ...proposal, nodeId: '2', inputPath: 'image', id: proposal.id,
        canonicalName: 'sourceImage', valueType: 'image_ref', transform: 'filename',
      }] }],
      ['duplicate proposal target', { ...base, proposals: [proposal, {
        ...proposal, id: 'second-prompt', canonicalName: 'negativePrompt',
      }] }],
      ['incompatible transform', { ...base, proposals: [{ ...proposal, transform: 'filename' }] }],
      ['filename_at without index', { ...base, proposals: [{
        ...proposal, canonicalName: 'referenceImages', nodeId: '2', inputPath: 'image',
        valueType: 'image_ref_list', transform: 'filename_at',
      }] }],
      ['output node missing', { ...base, outputs: [{ ...output, nodeId: 'missing-node' }] }],
      ['output path unsafe', { ...base, outputs: [{ ...output, fieldPath: '__proto__.images' }] }],
      ['output media mismatch', { ...base, outputs: [{ ...output, mediaType: 'video' }] }],
      ['duplicate output name', { ...base, outputs: [
        { ...output, primary: true }, { ...secondOutput, name: output.name },
      ] }],
      ['duplicate output target', { ...base, outputs: [
        { ...output, primary: true }, { ...secondOutput, nodeId: output.nodeId },
      ] }],
      ['multiple primary outputs', { ...base, outputs: [
        { ...output, primary: true }, { ...secondOutput, primary: true },
      ] }],
      ['single output without primary', { ...base, outputs: [{ ...output, primary: false }] }],
    ]
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')

    for (const [name, invalid, uploaded = base.graph] of cases) {
      apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ analysis: invalid }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      const sourceText = JSON.stringify(uploaded)
      const file = new File([sourceText], 'graph.json', { type: 'application/json' })
      Object.defineProperty(file, 'text', { value: () => Promise.resolve(sourceText) })

      const error = await analyzeWorkflowJson('image_generation', file).catch((reason: unknown) => reason)
      expect(error, name).toMatchObject({ name: 'WorkflowRequestError', code: 'UNKNOWN' })
    }
  })

  it('creates a workflow payload and rejects blank IDs and network failures safely', async () => {
    const draft: WorkflowAuthorDraft = {
      name: 'Portrait', mediaType: 'image', purpose: 'generation', apiFormatJson: '{}',
      variableDefinitions: [], bindings: [],
      outputs: [{ name: 'result', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
    }
    const apiFetch = vi.spyOn(apiFetchModule, 'apiFetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: { id: ' created-id ' } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: { id: '   ' } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new Error('private network diagnostics'))

    const creationId = '123e4567-e89b-42d3-a456-426614174000'
    await expect(createWorkflowDraft(draft, creationId)).resolves.toBe('created-id')
    expect(apiFetch).toHaveBeenLastCalledWith('/api/comfyui/workflows', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'generation', apiFormatJson: {}, variableDefinitions: [], bindings: [], outputs: draft.outputs,
        name: 'Portrait', mediaType: 'image', creationId,
      }),
    }))
    await expect(createWorkflowDraft(draft, creationId)).rejects.toMatchObject({ code: 'UNKNOWN' })
    const networkError = await createWorkflowDraft(draft, creationId).catch((reason: unknown) => reason)
    expect(networkError).toMatchObject({
      name: 'WorkflowRequestError', code: 'NETWORK_ERROR', message: 'workflowRequestFailed',
    })
    expect(safeWorkflowErrorKey(networkError)).toBe('workflowNetworkFailed')
    expect(String(networkError)).not.toContain('private network diagnostics')
    expect((networkError as Error & { cause?: unknown }).cause).toBeUndefined()
  })
})
