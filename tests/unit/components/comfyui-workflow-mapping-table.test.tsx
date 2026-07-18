// @vitest-environment jsdom

import React, { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkflowMappingTable from '@/app/[locale]/profile/components/comfyui/WorkflowMappingTable'
import type { ComfyInputBinding } from '@/lib/comfyui/types'
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

  it('renders numeric conversion settings for duration but not prompt bindings', () => {
    const onBindingsChange = vi.fn()
    const view = render(withMessages(<WorkflowMappingTable
      variables={[
        { name: 'duration', type: 'number', required: true },
        { name: 'prompt', type: 'string', required: true },
      ]}
      bindings={[
        {
          nodeId: 'timing', inputPath: 'length', variable: 'duration', valueType: 'number',
          numericTransform: {
            sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
            fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
            rounding: 'round', frameOffset: 1,
          },
        },
        { nodeId: 'prompt', inputPath: 'text', variable: 'prompt', valueType: 'string' },
      ]}
      outputs={[]}
      mediaType="video"
      onBindingsChange={onBindingsChange}
      onOutputsChange={vi.fn()}
    />))

    expect(view.getAllByLabelText('Output format')).toHaveLength(1)
    expect(view.getByLabelText('Sample duration')).toBeTruthy()
    expect(view.getByLabelText('Runtime FPS')).toBeTruthy()
    expect((view.getByLabelText('Fallback FPS') as HTMLInputElement).value).toBe('16')
    fireEvent.change(view.getByLabelText('First-frame offset'), { target: { value: '0' } })
    expect(onBindingsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ numericTransform: expect.objectContaining({ frameOffset: 0 }) }),
      expect.not.objectContaining({ numericTransform: expect.anything() }),
    ])
  })

  it('installs and removes identity numeric transforms when the mapped variable changes', () => {
    const onBindingsChange = vi.fn()
    function Harness() {
      const [bindings, setBindings] = useState<ComfyInputBinding[]>([{
        nodeId: 'timing', inputPath: 'value', variable: 'prompt', valueType: 'string',
      }])
      return <WorkflowMappingTable
        variables={[
          { name: 'prompt', type: 'string', required: true },
          { name: 'duration', type: 'number', required: true },
          { name: 'fps', type: 'number', required: false },
        ]}
        bindings={bindings}
        outputs={[]}
        mediaType="video"
        onBindingsChange={(next) => { onBindingsChange(next); setBindings(next) }}
        onOutputsChange={vi.fn()}
      />
    }
    const view = render(withMessages(<Harness />))

    fireEvent.change(view.getByLabelText('Variable'), { target: { value: 'duration' } })
    expect(onBindingsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        variable: 'duration', valueType: 'number',
        numericTransform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' },
      }),
    ])
    fireEvent.change(view.getByLabelText('Variable'), { target: { value: 'prompt' } })
    expect(onBindingsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        variable: 'prompt', valueType: 'string', numericTransform: undefined,
      }),
    ])
  })

  it('clears stale invalid allowed values when a saved duration binding switches to FPS', () => {
    const onBindingsChange = vi.fn()
    function Harness() {
      const [bindings, setBindings] = useState<ComfyInputBinding[]>([{
        nodeId: 'timing', inputPath: 'value', variable: 'duration', valueType: 'number',
        numericTransform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' },
      }])
      return <WorkflowMappingTable
        variables={[
          { name: 'duration', type: 'number', required: true },
          { name: 'fps', type: 'number', required: false },
        ]}
        bindings={bindings}
        outputs={[]}
        mediaType="video"
        onBindingsChange={(next) => { onBindingsChange(next); setBindings(next) }}
        onOutputsChange={vi.fn()}
      />
    }
    const view = render(withMessages(<Harness />))
    const allowedValues = view.getByLabelText('Allowed target values') as HTMLInputElement

    fireEvent.change(allowedValues, { target: { value: '5, later' } })
    expect(allowedValues.value).toBe('5, later')
    expect(view.getByRole('alert')).toBeTruthy()

    fireEvent.change(view.getByLabelText('Variable'), { target: { value: 'fps' } })

    expect(onBindingsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        variable: 'fps',
        numericTransform: { sourceUnit: 'fps', targetUnit: 'fps', output: 'number' },
      }),
    ])
    expect((view.getByLabelText('Allowed target values') as HTMLInputElement).value).toBe('')
    expect(view.queryByRole('alert')).toBeNull()
  })
})
