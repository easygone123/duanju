// @vitest-environment jsdom

import React, { useState } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkflowNumericTransformEditor from '@/app/[locale]/profile/components/comfyui/WorkflowNumericTransformEditor'
import type { ComfyNumericBindingTransform } from '@/lib/comfyui/types'
import enComfyui from '../../../messages/en/comfyui.json'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

function withMessages(child: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
    {child}
  </NextIntlClientProvider>
}

describe('WorkflowNumericTransformEditor', () => {
  it('configures frames and previews 81', () => {
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState<ComfyNumericBindingTransform>({
        sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
      })
      return <WorkflowNumericTransformEditor
        role="duration"
        value={value}
        sampleDuration={5}
        sampleFps={16}
        onChange={(next) => { onChange(next); setValue(next) }}
      />
    }
    const view = render(withMessages(<Harness />))

    fireEvent.change(view.getByLabelText('Target unit'), { target: { value: 'frames' } })
    fireEvent.change(view.getByLabelText('Fallback FPS'), { target: { value: '16' } })
    fireEvent.change(view.getByLabelText('First-frame offset'), { target: { value: '1' } })

    expect(view.getByText(/5.*16.*1.*81/)).toBeTruthy()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUnit: 'seconds',
      targetUnit: 'frames',
      fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
      frameOffset: 1,
    }))
  })

  it('edits preview samples and shows the selected rounding calculation', () => {
    function Harness() {
      const [value, setValue] = useState<ComfyNumericBindingTransform>({
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 24 },
        rounding: 'round', frameOffset: 1,
      })
      return <WorkflowNumericTransformEditor role="duration" value={value} onChange={setValue} />
    }
    const view = render(withMessages(<Harness />))

    fireEvent.change(view.getByLabelText('Sample duration'), { target: { value: '5.1' } })
    fireEvent.change(view.getByLabelText('Runtime FPS'), { target: { value: '16' } })
    fireEvent.change(view.getByLabelText('Rounding'), { target: { value: 'floor' } })

    expect(view.getByText(/floor\(5\.1.*16\).*1.*82/)).toBeTruthy()
  })

  it('previews fractional numeric-string seconds', () => {
    const view = render(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      value={{ sourceUnit: 'seconds', targetUnit: 'seconds', output: 'numeric_string' }}
      sampleDuration={5.5}
      sampleFps={24}
      onChange={() => undefined}
    />))

    expect(view.getByText(/"5.5"/)).toBeTruthy()
  })

  it('keeps invalid allowed values visible and emits an invalid blocking transform', () => {
    const onChange = vi.fn()
    const view = render(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      value={{ sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' }}
      sampleDuration={5}
      sampleFps={16}
      onChange={onChange}
    />))

    const allowedValues = view.getByLabelText('Allowed target values')
    fireEvent.change(allowedValues, { target: { value: '5, later' } })

    expect((allowedValues as HTMLInputElement).value).toBe('5, later')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      allowedTargetValues: [],
    }))
    const error = view.getByRole('alert')
    expect(error.textContent).toContain('valid numbers')
    expect(error.id).not.toBe('')
    expect(allowedValues.getAttribute('aria-invalid')).toBe('true')
    expect(allowedValues.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('preserves invalid text for the same binding but clears it for a new binding identity', () => {
    const onChange = vi.fn()
    const validValue: ComfyNumericBindingTransform = {
      sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
    }
    const view = render(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      mappingIdentity="timing.length"
      value={validValue}
      onChange={onChange}
    />))

    fireEvent.change(view.getByLabelText('Allowed target values'), {
      target: { value: '5, later' },
    })
    view.rerender(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      mappingIdentity="timing.length"
      value={{ ...validValue, allowedTargetValues: [] }}
      onChange={onChange}
    />))
    expect((view.getByLabelText('Allowed target values') as HTMLInputElement).value)
      .toBe('5, later')
    expect(view.getByRole('alert')).toBeTruthy()

    view.rerender(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      mappingIdentity="timing.frames"
      value={validValue}
      onChange={onChange}
    />))
    expect((view.getByLabelText('Allowed target values') as HTMLInputElement).value).toBe('')
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByLabelText('Allowed target values').getAttribute('aria-invalid')).toBeNull()
  })

  it('rejects decimal-safe duplicate allowed values without discarding the text', () => {
    const onChange = vi.fn()
    const view = render(withMessages(<WorkflowNumericTransformEditor
      role="duration"
      value={{ sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' }}
      onChange={onChange}
    />))

    const allowedValues = view.getByLabelText('Allowed target values') as HTMLInputElement
    fireEvent.change(allowedValues, { target: { value: '0.30000000000000004, 0.3' } })

    expect(allowedValues.value).toBe('0.30000000000000004, 0.3')
    expect(view.getByRole('alert')).toBeTruthy()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      allowedTargetValues: [],
    }))
  })

  it('locks FPS mappings to fps units and hides frame conversion controls', () => {
    const view = render(withMessages(<WorkflowNumericTransformEditor
      role="fps"
      value={{ sourceUnit: 'fps', targetUnit: 'fps', output: 'number' }}
      sampleDuration={5}
      sampleFps={24}
      onChange={() => undefined}
    />))

    expect(view.queryByLabelText('Target unit')).toBeNull()
    expect(view.queryByLabelText('Fallback FPS')).toBeNull()
    expect(view.getByLabelText('Output format')).toBeTruthy()
    expect(view.getByLabelText('Allowed target values')).toBeTruthy()
  })
})
