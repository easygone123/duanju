// @vitest-environment jsdom

import React from 'react'
import { render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkflowMappingTable from '@/app/[locale]/profile/components/comfyui/WorkflowMappingTable'
import enComfyui from '../../../messages/en/comfyui.json'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

function withMessages(child: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
    {child}
  </NextIntlClientProvider>
}

describe('WorkflowMappingTable', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses the input mapping heading when repair is requested', () => {
    const props = {
      variables: [],
      bindings: [],
      outputs: [],
      mediaType: 'image' as const,
      onBindingsChange: vi.fn(),
      onOutputsChange: vi.fn(),
    }
    const view = render(withMessages(<WorkflowMappingTable {...props} focusRequestId={0} />))
    const heading = view.getByRole('heading', { name: 'Node input mappings' })
    expect(document.activeElement).not.toBe(heading)

    view.rerender(withMessages(<WorkflowMappingTable {...props} focusRequestId={1} />))

    expect(document.activeElement).toBe(heading)
  })
})
