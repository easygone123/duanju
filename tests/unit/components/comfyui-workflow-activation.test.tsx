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

describe('workflow activation state', () => {
  it('keeps a statically invalid saved workflow in Draft', () => {
    expect(initialWorkflowActivationState({ valid: false }).status).toBe('draft')
  })

  it('keeps a successful test when publish fails so retry only needs publishing', () => {
    const tested = nextWorkflowActivationState(initialWorkflowActivationState(), 'test_succeeded')
    const failed = nextWorkflowActivationState(tested, 'publish_failed')

    expect(failed).toMatchObject({ status: 'ready_to_publish', testComplete: true, publishRequired: true, error: 'publish' })
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
    expect((view.getByRole('button', { name: 'Test and enable' }) as HTMLButtonElement).disabled).toBe(true)
    expect(requestWorkflowActionMock).not.toHaveBeenCalled()
  })

  it('selects the first enabled instance when connections finish loading', async () => {
    connections.current = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    connections.current = [{ id: 'connection-late', name: 'Late ComfyUI', enabled: true }]
    view.rerender(activationTree(queryClient))

    await waitFor(() => expect((view.getByRole('button', { name: 'Test and enable' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('blocks activation until all required live-test inputs are provided', async () => {
    const requiredPrompt = version([{ name: 'prompt', type: 'string', required: true }])
    const view = renderPanel({ version: requiredPrompt })

    expect((view.getByRole('button', { name: 'Test and enable' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(view.getByLabelText('prompt *'), { target: { value: 'a portrait' } })

    await waitFor(() => expect((view.getByRole('button', { name: 'Test and enable' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('never publishes when the live test fails', async () => {
    requestWorkflowActionMock.mockRejectedValueOnce(new Error('test failed'))
    const view = renderPanel()

    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))

    await waitFor(() => expect(view.getByText('The live test failed. Nothing was published.')).toBeTruthy())
    expect(requestWorkflowActionMock).toHaveBeenCalledTimes(1)
    expect(requestWorkflowActionMock.mock.calls[0]?.[0]).toContain('/test-run')
  })

  it('retries only the exact-version publish after publish failure', async () => {
    requestWorkflowActionMock
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('publish failed'))
      .mockResolvedValueOnce({ success: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(activationTree(queryClient))

    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
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

    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Retry publish' })).toBeTruthy())
    view.rerender(activationTree(queryClient, { version: { ...version(), id: 'version-8', version: 8 } }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Test and enable' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[2]?.[1]?.body)).toMatchObject({ versionId: 'version-8' })
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[3]?.[1]?.body)).toEqual({ versionId: 'version-8' })
  })

  it('publishes the tested exact version and invalidates user models', async () => {
    requestWorkflowActionMock.mockResolvedValue({ success: true })
    const onActivated = vi.fn()
    const view = renderPanel({ onActivated })

    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))

    await waitFor(() => expect(view.getByText('Available as model')).toBeTruthy())
    expect(JSON.parse(requestWorkflowActionMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      versionId: 'version-7',
      connectionId: 'connection-1',
    })
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
