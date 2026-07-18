// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StoryboardModeSummary from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardModeSummary'
import enNovelPromotion from '../../../messages/en/novel-promotion.json'

afterEach(cleanup)

function renderSummary(props: React.ComponentProps<typeof StoryboardModeSummary>) {
  return render(<NextIntlClientProvider
    locale="en"
    messages={{ novelPromotion: enNovelPromotion }}
    timeZone="UTC"
  >
    <StoryboardModeSummary {...props} />
  </NextIntlClientProvider>)
}

describe('storyboard mode summary', () => {
  it.each([
    ['four_grid', '16:9', '2×2', '16:9'],
    ['six_grid', '16:9', '3×2', '8:3'],
    ['four_grid', '9:16', '2×2', '9:16'],
    ['six_grid', '9:16', '3×2', '27:32'],
  ] as const)('shows the active %s layout and derived sheet ratio', (
    mode,
    cellRatio,
    layout,
    sheetRatio,
  ) => {
    const view = renderSummary({
      mode,
      cellRatio,
      videoRatio: '16:9',
      onOpenSettings: vi.fn(),
    })

    expect(view.getByText(layout)).toBeTruthy()
    expect(view.getByText(sheetRatio)).toBeTruthy()
  })

  it('returns to story settings without mutating storyboard data', () => {
    const onOpenSettings = vi.fn()
    const view = renderSummary({
      mode: 'four_grid',
      cellRatio: null,
      videoRatio: '16:9',
      onOpenSettings,
    })

    fireEvent.click(view.getByRole('button', { name: 'Change in story settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows individual mode without a sheet ratio', () => {
    const view = renderSummary({
      mode: 'individual',
      cellRatio: null,
      videoRatio: '16:9',
      onOpenSettings: vi.fn(),
    })

    expect(view.getByText('Individual panels')).toBeTruthy()
    expect(view.queryByText('Whole-sheet ratio')).toBeNull()
  })

  it('marks a changed project mode as pending until the storyboard is rebuilt', () => {
    const view = renderSummary({
      mode: 'four_grid',
      cellRatio: '16:9',
      videoRatio: '16:9',
      persistedModes: ['six_grid'],
      onOpenSettings: vi.fn(),
    })

    expect(view.getByRole('status').textContent).toContain(
      'This mode applies to the next storyboard rebuild',
    )
    expect(view.getByRole('status').textContent).toContain('Current storyboard data: 3×2 six-grid')
  })

  it('does not show a pending warning when persisted rows match the configured mode', () => {
    const view = renderSummary({
      mode: 'four_grid',
      cellRatio: '16:9',
      videoRatio: '16:9',
      persistedModes: ['four_grid'],
      onOpenSettings: vi.fn(),
    })

    expect(view.queryByRole('status')).toBeNull()
  })
})
