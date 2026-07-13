// @vitest-environment jsdom

import React, { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import SixGridCropModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal'
import type { NovelPromotionStoryboard } from '@/types/project'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const messages = { storyboard: { sixGrid: {
  upscaledSheetRequired: 'Upscaled source required', sourceOrderMismatch: 'Wrong source order',
  cropModal: {
    title: 'Crop six panels', source: 'Crop source', original: 'Original', upscaled: 'Upscaled',
    cell: 'Cell {cell}', resetCell: 'Reset cell', resetAll: 'Reset all', cancel: 'Cancel',
    submit: 'Submit crops', moveHint: 'Move hint', shrink: 'Shrink', grow: 'Grow', resize: 'Resize cell {cell}',
  },
} } }

function storyboard(overrides: Partial<NovelPromotionStoryboard> = {}): NovelPromotionStoryboard {
  return {
    id: 'storyboard-1', episodeId: 'episode-1', clipId: 'clip-1', storyboardTextJson: null,
    panelCount: 6, storyboardImageUrl: null, layoutMode: 'six_grid', groupSequence: 0,
    sixGridCellAspectRatio: '16:9', sixGridProcessingOrder: 'crop_then_panel_upscale',
    sheetImageUrl: '/original.webp', upscaledSheetImageUrl: '/upscaled.webp', panels: [],
    ...overrides,
  }
}

function modal(element: React.ReactElement) {
  return createElement(NextIntlClientProvider, {
    locale: 'en', messages, timeZone: 'UTC', children: element,
  } as React.ComponentProps<typeof NextIntlClientProvider>)
}

function loadImage(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  fireEvent.load(image)
}

function cropButton(view: ReturnType<typeof render>) {
  return view.getAllByRole('button', { name: 'Cell 1' }).find((button) => button.classList.contains('absolute')) as HTMLButtonElement
}

describe('six-grid crop modal interactions', () => {
  it('initializes only on a new open session and preserves dirty edits across SSE rerenders', () => {
    const props = { storyboard: storyboard(), initialCellIndex: 0, onClose: vi.fn(), onSubmit: vi.fn(async () => undefined) }
    const view = render(modal(createElement(SixGridCropModal, { ...props, isOpen: false })))
    view.rerender(modal(createElement(SixGridCropModal, { ...props, isOpen: true })))
    loadImage(view.getByRole('img') as HTMLImageElement, 1600, 900)
    fireEvent.click(view.getByRole('button', { name: 'Grow' }))
    const crop = cropButton(view)
    const dirtyWidth = crop.style.width

    const refreshed = storyboard({ panels: Array.from({ length: 6 }, (_, index) => ({
      id: `panel-${index}`, storyboardId: 'storyboard-1', panelIndex: index, gridCellIndex: index,
      normalizedCropRect: { x: (index % 3) / 3, y: Math.floor(index / 3) / 2, width: 0.2, height: 0.3 },
    })) as NovelPromotionStoryboard['panels'] })
    view.rerender(modal(createElement(SixGridCropModal, { ...props, storyboard: refreshed, isOpen: true })))
    expect(cropButton(view).style.width).toBe(dirtyWidth)
  })

  it('keeps independent dirty rectangles when switching between original and upscaled sources', () => {
    const props = { storyboard: storyboard(), isOpen: true, onClose: vi.fn(), onSubmit: vi.fn(async () => undefined) }
    const view = render(modal(createElement(SixGridCropModal, props)))
    loadImage(view.getByRole('img') as HTMLImageElement, 1600, 900)
    fireEvent.click(view.getByRole('button', { name: 'Grow' }))
    const originalWidth = cropButton(view).style.width

    fireEvent.change(view.getByRole('combobox'), { target: { value: 'upscaled' } })
    loadImage(view.getByRole('img') as HTMLImageElement, 1200, 1200)
    fireEvent.click(view.getByRole('button', { name: 'Shrink' }))
    const upscaledWidth = cropButton(view).style.width
    expect(upscaledWidth).not.toBe(originalWidth)

    fireEvent.change(view.getByRole('combobox'), { target: { value: 'original' } })
    expect(cropButton(view).style.width).toBe(originalWidth)
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'upscaled' } })
    expect(cropButton(view).style.width).toBe(upscaledWidth)
  })

  it('traps focus, closes on Escape, and restores focus to the trigger', () => {
    const onClose = vi.fn()
    const props = { storyboard: storyboard(), onClose, onSubmit: vi.fn(async () => undefined) }
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const view = render(modal(createElement(SixGridCropModal, { ...props, isOpen: false })))
    view.rerender(modal(createElement(SixGridCropModal, { ...props, isOpen: true })))
    const dialog = view.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])'))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
    dialog.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusable.at(-1))
    focusable.at(-1)!.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
    focusable[0].focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusable.at(-1))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(modal(createElement(SixGridCropModal, { ...props, isOpen: false })))
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('resizes from the bottom-right pointer handle with locked ratio inside its cell', () => {
    const view = render(modal(createElement(SixGridCropModal, {
      storyboard: storyboard(), isOpen: true, onClose: vi.fn(), onSubmit: vi.fn(async () => undefined),
    })))
    const image = view.getByRole('img') as HTMLImageElement
    loadImage(image, 1600, 900)
    const preview = image.parentElement as HTMLDivElement
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}),
    })
    const crop = cropButton(view)
    const before = Number.parseFloat(crop.style.width)
    const handle = view.getByRole('button', { name: 'Resize cell 1' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    const width = Number.parseFloat(crop.style.width)
    const height = Number.parseFloat(crop.style.height)
    expect(width).toBeGreaterThanOrEqual(before)
    expect(width).toBeLessThanOrEqual(100 / 3 + 0.001)
    expect((width / height) * (1600 / 900)).toBeCloseTo(16 / 9, 2)
  })
})
