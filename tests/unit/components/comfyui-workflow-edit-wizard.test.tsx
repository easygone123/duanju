// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkflowEditWizard from '@/app/[locale]/profile/components/comfyui/WorkflowEditWizard'
import type { WorkflowAuthorDraft, WorkflowVersionView } from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import enComfyui from '../../../messages/en/comfyui.json'

vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowActivationPanel', () => ({
  default: ({ version }: { version: WorkflowVersionView }) => (
    <output aria-label="prepared-version">{version.id}</output>
  ),
}))

afterEach(cleanup)

const draft: WorkflowAuthorDraft = {
  name: 'LTX frames',
  mediaType: 'video',
  purpose: 'generation',
  apiFormatJson: JSON.stringify({
    prompt: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'animate' } },
    first: { class_type: 'LoadImage', inputs: { image: 'first.png' } },
    last: { class_type: 'LoadImage', inputs: { image: 'last.png' } },
    out: { class_type: 'VHS_VideoCombine', inputs: { images: ['first', 0] } },
  }),
  variableDefinitions: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'firstFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
    { name: 'lastFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
  ],
  bindings: [
    { nodeId: 'prompt', inputPath: 'value', variable: 'prompt', valueType: 'string' },
    {
      nodeId: 'first', inputPath: 'image', variable: 'firstFrame', valueType: 'image_ref',
      transform: 'filename', missingValuePolicy: 'preserve_original',
    },
    {
      nodeId: 'last', inputPath: 'image', variable: 'lastFrame', valueType: 'image_ref',
      transform: 'filename', missingValuePolicy: 'preserve_original',
    },
  ],
  outputs: [{ name: 'video', nodeId: 'out', fieldPath: 'gifs', mediaType: 'video', primary: true }],
}

const preparedVersion: WorkflowVersionView = {
  id: 'version-prepared', version: 3, purpose: 'generation',
  apiFormatJson: JSON.parse(draft.apiFormatJson),
  variableDefinitions: draft.variableDefinitions,
  bindings: draft.bindings,
  outputs: draft.outputs,
  contentHash: 'prepared-hash', publishedAt: null, lastSuccessfulTestAt: null,
  validation: { valid: true, issues: [] },
}

describe('WorkflowEditWizard', () => {
  it('prepares the currently edited first and last frame mappings before opening test', async () => {
    const onPrepareTest = vi.fn().mockResolvedValue(preparedVersion)
    const view = render(
      <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
        <WorkflowEditWizard
          workflowId="workflow-1"
          initialDraft={draft}
          onCancel={vi.fn()}
          onPrepareTest={onPrepareTest}
          onPublished={vi.fn()}
        />
      </NextIntlClientProvider>,
    )

    expect(view.getAllByText('First frame').length).toBeGreaterThan(0)
    expect(view.getAllByText('Last frame').length).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Continue to test' }))
    })

    expect(onPrepareTest).toHaveBeenCalledWith(expect.objectContaining({
      variableDefinitions: expect.arrayContaining([
        expect.objectContaining({ name: 'firstFrame' }),
        expect.objectContaining({ name: 'lastFrame' }),
      ]),
      bindings: expect.arrayContaining([
        expect.objectContaining({ variable: 'firstFrame', nodeId: 'first' }),
        expect.objectContaining({ variable: 'lastFrame', nodeId: 'last' }),
      ]),
    }))
    expect(view.getByLabelText('prepared-version').textContent).toBe('version-prepared')
  })
})
