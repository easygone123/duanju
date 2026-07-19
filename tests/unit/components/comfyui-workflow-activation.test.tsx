// @vitest-environment jsdom

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import WorkflowActivationPanel from '@/app/[locale]/profile/components/comfyui/WorkflowActivationPanel'
import {
  initialWorkflowActivationState,
  nextWorkflowActivationState,
} from '@/app/[locale]/profile/components/comfyui/workflow-activation'
import type { WorkflowVersionView } from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import enComfyui from '../../../messages/en/comfyui.json'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const requestWorkflowActionMock = vi.hoisted(() => vi.fn())
const invalidateUserModelsMock = vi.hoisted(() => vi.fn())
const connections = vi.hoisted(() => ({ current: [] as Array<{ id: string; name: string; enabled: boolean }> }))

vi.mock('@/app/[locale]/profile/components/comfyui/workflow-requests', () => ({
  requestWorkflowAction: requestWorkflowActionMock,
}))
vi.mock('@/lib/query/hooks/useUserModels', () => ({
  invalidateUserModels: invalidateUserModelsMock,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/hooks', () => ({
  useComfyConnections: () => ({ data: { connections: connections.current } }),
}))

const version = (definitions: WorkflowVersionView['variableDefinitions'] = []): WorkflowVersionView => ({
  id: 'version-7',
  version: 7,
  purpose: 'generation',
  apiFormatJson: { '1': { class_type: 'SaveImage', inputs: {} } },
  variableDefinitions: definitions,
  bindings: [],
  outputs: [{ name: 'image', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true }],
  contentHash: 'hash-7',
  publishedAt: null,
  lastSuccessfulTestAt: null,
  validation: { valid: true, issues: [] },
})

const videoFrameVersion = (): WorkflowVersionView => ({
  ...version([{ name: 'duration', type: 'number', required: false }]),
  apiFormatJson: {
    '1': { class_type: 'VideoSampler', inputs: { length: 81 } },
    '2': { class_type: 'SaveVideo', inputs: { video: ['1', 0] } },
  },
  bindings: [{
    nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
    numericTransform: {
      sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
      fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
      rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
    },
  }],
  outputs: [{ name: 'video', nodeId: '2', fieldPath: 'videos', mediaType: 'video', primary: true }],
})

function activationTree(queryClient: QueryClient, props: Partial<React.ComponentProps<typeof WorkflowActivationPanel>> = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
        <WorkflowActivationPanel workflowId="workflow/a b" version={version()} onClose={vi.fn()} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>
  )
}

function renderPanel(props: Partial<React.ComponentProps<typeof WorkflowActivationPanel>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(activationTree(queryClient, props))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('workflow activation state', () => {
  it('keeps a statically invalid saved workflow in Draft', () => {
    expect(initialWorkflowActivationState({ valid: false }).status).toBe('draft')
  })

  it('keeps a successful test when publish fails so retry only needs publishing', () => {
    const tested = nextWorkflowActivationState(initialWorkflowActivationState(), 'test_succeeded')
    const failed = nextWorkflowActivationState(tested, 'publish_failed')

    expect(failed).toMatchObject({ status: 'ready_to_publish', testComplete: true, publishRequired: true, error: 'publish' })
  })

  it('requires both publication and a successful test before becoming available', () => {
    expect(initialWorkflowActivationState({ published: true, tested: false }).status).toBe('needs_test')
    expect(initialWorkflowActivationState({ published: true, tested: true }).status).toBe('available')
  })
})

describe('WorkflowActivationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connections.current = [{ id: 'connection-1', name: 'Local ComfyUI', enabled: true }]
  })

  afterEach(cleanup)

  it('blocks activation when there is no enabled owned instance', () => {
    connections.current = []
    const view = renderPanel()

    expect(view.getByText('No enabled ComfyUI instance is available.')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Test workflow' }) as HTMLButtonElement).disabled).toBe(true)
    expect(requestWorkflowActionMock).not.toHaveBeenCalled()
  })

  it('selects the first enabled instance when connections finish loading', async () => {
    connections.current = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    connections.current = [{ id: 'connection-late', name: 'Late ComfyUI', enabled: true }]
    view.rerender(activationTree(queryClient))

    await waitFor(() => expect((view.getByRole('button', { name: 'Test workflow' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('blocks activation until all required live-test inputs are provided', async () => {
    const requiredPrompt = version([{ name: 'prompt', type: 'string', required: true }])
    const view = renderPanel({ version: requiredPrompt })

    expect((view.getByRole('button', { name: 'Test workflow' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(view.getByLabelText('prompt *'), { target: { value: 'a portrait' } })

    await waitFor(() => expect((view.getByRole('button', { name: 'Test workflow' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('shows optional media uploads while hiding unrelated optional scalar variables', () => {
    const liveVersion = version([
      { name: 'prompt', type: 'string', required: true },
      { name: 'optionalStyle', type: 'string', required: false, missingValuePolicy: 'preserve_original' },
      { name: 'firstFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
      { name: 'lastFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
    ])
    const view = renderPanel({ version: liveVersion })

    expect(view.getByLabelText('prompt *')).toBeTruthy()
    expect(view.queryByLabelText('optionalStyle')).toBeNull()
    expect(view.getByLabelText('firstFrame')).toBeTruthy()
    expect(view.getByLabelText('lastFrame')).toBeTruthy()
  })

  it('defaults a frame-mapped video test to its shortest supported duration', async () => {
    requestWorkflowActionMock.mockResolvedValue({ success: true })
    const view = renderPanel({ mediaType: 'video', version: videoFrameVersion() })

    expect((view.getByLabelText(/Test duration \(seconds\)/) as HTMLSelectElement).value).toBe('5')
    expect(view.getByText('Converted to total frames by this mapping.')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))

    await waitFor(() => expect(requestWorkflowActionMock).toHaveBeenCalled())
    expect(JSON.parse(String(requestWorkflowActionMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      variables: { duration: 5 },
    })
  })

  it('blocks a video test without a duration mapping and offers mapping repair immediately', () => {
    const onEditMappings = vi.fn()
    const view = renderPanel({ mediaType: 'video', version: version(), onEditMappings })

    expect(view.getByText('Add a duration or total-frame mapping before testing this video workflow.')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Test workflow' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Return to edit mappings' }))
    expect(onEditMappings).toHaveBeenCalledTimes(1)
    expect(requestWorkflowActionMock).not.toHaveBeenCalled()
  })

  it('uses a synchronous lock to ignore same-frame activation double clicks', async () => {
    const testRun = deferred<unknown>()
    requestWorkflowActionMock.mockReturnValueOnce(testRun.promise).mockResolvedValueOnce({ success: true })
    const view = renderPanel()
    const activate = view.getByRole('button', { name: 'Test workflow' })

    fireEvent.click(activate)
    fireEvent.click(activate)

    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    testRun.resolve({ success: true })
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
  })

  it('does not publish a delayed test result after activation is closed', async () => {
    const testRun = deferred<unknown>()
    requestWorkflowActionMock.mockReturnValueOnce(testRun.promise)
    const onClose = vi.fn()
    const onActivated = vi.fn()
    const view = renderPanel({ onClose, onActivated })

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    fireEvent.click(view.getByRole('button', { name: 'Close activation' }))
    testRun.resolve({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserModelsMock).not.toHaveBeenCalled()
    expect(onActivated).not.toHaveBeenCalled()
  })

  it('does not publish a delayed test result after unmount', async () => {
    const testRun = deferred<unknown>()
    requestWorkflowActionMock.mockReturnValueOnce(testRun.promise)
    const view = renderPanel()

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    view.unmount()
    testRun.resolve({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserModelsMock).not.toHaveBeenCalled()
  })

  it('ignores a delayed test result after switching immutable versions', async () => {
    const testRun = deferred<unknown>()
    requestWorkflowActionMock.mockReturnValueOnce(testRun.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    view.rerender(activationTree(queryClient, { version: { ...version(), id: 'version-8', version: 8 } }))
    testRun.resolve({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(view.getByRole('button', { name: 'Test workflow' })).toBeTruthy()
  })

  it('announces publishing and exposes busy state while publish is delayed', async () => {
    const publish = deferred<unknown>()
    requestWorkflowActionMock.mockResolvedValueOnce({ success: true }).mockReturnValueOnce(publish.promise)
    const view = renderPanel()

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(requestWorkflowActionMock).toHaveBeenCalledTimes(2))

    const region = view.getByRole('region', { name: 'Test and enable' })
    expect(region.getAttribute('aria-busy')).toBe('true')
    expect(view.getByRole('status').textContent).toBe('Publishing workflow…')
    publish.resolve({ success: true })
    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(region.getAttribute('aria-busy')).toBe('false')
  })

  it('invalidates models without completing stale UI after close while publish is delayed', async () => {
    const publish = deferred<unknown>()
    const onClose = vi.fn()
    const onActivated = vi.fn()
    requestWorkflowActionMock.mockResolvedValueOnce({ success: true }).mockReturnValueOnce(publish.promise)
    const view = renderPanel({ onClose, onActivated })

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(requestWorkflowActionMock).toHaveBeenCalledTimes(2))
    fireEvent.click(view.getByRole('button', { name: 'Close activation' }))
    publish.resolve({ success: true })

    await waitFor(() => expect(invalidateUserModelsMock).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onActivated).not.toHaveBeenCalled()
    expect(view.getByRole('status').textContent).toBe('Publishing workflow…')
  })

  it('invalidates models without stale callbacks after unmount while publish is delayed', async () => {
    const publish = deferred<unknown>()
    const onActivated = vi.fn()
    requestWorkflowActionMock.mockResolvedValueOnce({ success: true }).mockReturnValueOnce(publish.promise)
    const view = renderPanel({ onActivated })

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(requestWorkflowActionMock).toHaveBeenCalledTimes(2))
    view.unmount()
    publish.resolve({ success: true })

    await waitFor(() => expect(invalidateUserModelsMock).toHaveBeenCalledTimes(1))
    expect(onActivated).not.toHaveBeenCalled()
  })

  it('never publishes when the live test fails', async () => {
    requestWorkflowActionMock.mockRejectedValueOnce(new Error('test failed'))
    const view = renderPanel()

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))

    await waitFor(() => expect(view.getByText('The live test failed. Nothing was published.')).toBeTruthy())
    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(requestWorkflowActionMock.mock.calls[0]?.[0]).toContain('/test-run')
  })

  it('offers mapping repair only after a failed live test', async () => {
    requestWorkflowActionMock.mockRejectedValueOnce(new Error('test failed'))
    const onEditMappings = vi.fn()
    const view = renderPanel({ onEditMappings })

    expect(view.queryByRole('button', { name: 'Return to edit mappings' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', {
      name: 'Return to edit mappings',
    })).toBeTruthy())

    fireEvent.click(view.getByRole('button', { name: 'Return to edit mappings' }))
    expect(onEditMappings).toHaveBeenCalledTimes(1)
  })

  it('retries only the exact-version publish after publish failure', async () => {
    requestWorkflowActionMock
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('publish failed'))
      .mockResolvedValueOnce({ success: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Retry publish' })).toBeTruthy())
    connections.current = []
    view.rerender(activationTree(queryClient))
    await waitFor(() => expect((view.getByRole('button', { name: 'Retry publish' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(view.getByRole('button', { name: 'Retry publish' }))

    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(requestWorkflowActionMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/comfyui/workflows/workflow%2Fa%20b/test-run',
      '/api/comfyui/workflows/workflow%2Fa%20b/publish',
      '/api/comfyui/workflows/workflow%2Fa%20b/publish',
    ])
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[2]?.[1]?.body)).toEqual({ versionId: 'version-7' })
  })

  it('requires a new test when the selected immutable version changes', async () => {
    requestWorkflowActionMock
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('publish failed'))
      .mockResolvedValue({ success: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Retry publish' })).toBeTruthy())
    view.rerender(activationTree(queryClient, { version: { ...version(), id: 'version-8', version: 8 } }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Test workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))
    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[2]?.[1]?.body)).toMatchObject({ versionId: 'version-8' })
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[3]?.[1]?.body)).toEqual({ versionId: 'version-8' })
  })

  it('waits for explicit confirmation before publishing the tested exact version', async () => {
    requestWorkflowActionMock.mockResolvedValue({ success: true })
    const onActivated = vi.fn()
    const view = renderPanel({ onActivated })

    fireEvent.click(view.getByRole('button', { name: 'Test workflow' }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Publish workflow' })).toBeTruthy())
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      versionId: 'version-7',
      connectionId: 'connection-1',
    })
    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserModelsMock).not.toHaveBeenCalled()
    expect(onActivated).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: 'Publish workflow' }))

    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[1]?.[1]?.body)).toEqual({ versionId: 'version-7' })
    expect(invalidateUserModelsMock).toHaveBeenCalledTimes(1)
    expect(onActivated).toHaveBeenCalledTimes(1)
  })

  it('closes without deleting the saved draft', () => {
    const onClose = vi.fn()
    const view = renderPanel({ onClose })

    fireEvent.click(view.getByRole('button', { name: 'Close activation' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestWorkflowActionMock).not.toHaveBeenCalled()
  })
})
