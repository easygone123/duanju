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
})
