// @vitest-environment jsdom

import React, { createRef } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import GlassModalShell from '@/components/ui/primitives/GlassModalShell'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/components/ui/icons', () => ({ AppIcon: () => <span /> }))

beforeEach(() => {
  document.body.style.overflow = 'clip'
})

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

describe('GlassModalShell accessibility and viewport behavior', () => {
  it('names and describes the dialog, focuses the requested control, and scrolls only content', async () => {
    const initialFocusRef = createRef<HTMLButtonElement>()
    const view = render(
      <GlassModalShell
        open
        onClose={vi.fn()}
        title="Upload image"
        description="Choose a safe image"
        initialFocusRef={initialFocusRef}
        footer={<button type="button">Confirm</button>}
      >
        <button ref={initialFocusRef} type="button">Choose file</button>
      </GlassModalShell>,
    )

    const dialog = view.getByRole('dialog', { name: 'Upload image' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a safe image')
    await waitFor(() => expect(document.activeElement).toBe(initialFocusRef.current))

    const surface = dialog.querySelector('[data-glass-modal-surface]')!
    const content = dialog.querySelector('[data-glass-modal-content]')!
    expect(surface.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(surface.className).toContain('flex-col')
    expect(content.className).toContain('min-h-0')
    expect(content.className).toContain('overflow-y-auto')
  })

  it('traps Tab and Shift+Tab and restores focus after close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const view = render(
      <GlassModalShell open onClose={vi.fn()} title="Focus modal" showCloseButton={false}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </GlassModalShell>,
    )
    const first = view.getByRole('button', { name: 'First' })
    const last = view.getByRole('button', { name: 'Last' })
    await waitFor(() => expect(document.activeElement).toBe(first))

    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    view.rerender(<GlassModalShell open={false} onClose={vi.fn()} title="Focus modal">content</GlassModalShell>)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('sends Escape only to the top modal and reference-counts isolation and scroll locking', async () => {
    const closeLower = vi.fn()
    const closeUpper = vi.fn()
    const view = render(<>
      <main data-testid="background">background</main>
      <GlassModalShell open onClose={closeLower} title="Lower">lower</GlassModalShell>
      <GlassModalShell open onClose={closeUpper} title="Upper">upper</GlassModalShell>
    </>)
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'))
    const backgroundRoot = view.container
    expect(backgroundRoot.hasAttribute('inert')).toBe(true)
    expect(backgroundRoot.getAttribute('aria-hidden')).toBe('true')
    expect(view.getByRole('dialog', { name: 'Lower', hidden: true }).hasAttribute('inert')).toBe(false)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeUpper).toHaveBeenCalledTimes(1)
    expect(closeLower).not.toHaveBeenCalled()

    view.rerender(<>
      <main>background</main>
      <GlassModalShell open onClose={closeLower} title="Lower">lower</GlassModalShell>
      <GlassModalShell open={false} onClose={closeUpper} title="Upper">upper</GlassModalShell>
    </>)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Upper' })).toBeNull())
    expect(document.body.style.overflow).toBe('hidden')
    expect(backgroundRoot.hasAttribute('inert')).toBe(true)

    view.rerender(<GlassModalShell open={false} onClose={closeLower} title="Lower">lower</GlassModalShell>)
    await waitFor(() => expect(document.body.style.overflow).toBe('clip'))
    expect(backgroundRoot.hasAttribute('inert')).toBe(false)
    expect(backgroundRoot.hasAttribute('aria-hidden')).toBe(false)
  })
})
