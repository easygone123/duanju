// @vitest-environment jsdom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StoryboardGroupActions from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroupActions'

vi.mock('@/components/ui/icons', () => ({ AppIcon: () => null }))
vi.mock('@/components/ui/primitives', () => ({
  GlassButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

afterEach(cleanup)

const messages = {
  storyboard: {
    group: {
      regenerateText: 'Regenerate text',
      generateMissingImages: 'Generate missing images',
      generateAll: 'Generate all',
      addPanel: 'Add panel',
    },
    common: { delete: 'Delete' },
  },
}

function renderActions(isGridLayout: boolean) {
  return render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <StoryboardGroupActions
      hasAnyImage={false}
      isSubmittingStoryboardTask={false}
      isSubmittingStoryboardTextTask={false}
      currentRunningCount={0}
      pendingCount={0}
      isGridLayout={isGridLayout}
      onRegenerateText={vi.fn()}
      onGenerateAllIndividually={vi.fn()}
      onAddPanel={vi.fn()}
      onDeleteStoryboard={vi.fn()}
    />
  </NextIntlClientProvider>)
}

describe('storyboard group cardinality actions', () => {
  it('hides add-panel for fixed-cardinality grid rows', () => {
    const view = renderActions(true)
    expect(view.queryByRole('button', { name: 'Add panel' })).toBeNull()
  })

  it('keeps add-panel for individual rows', () => {
    const view = renderActions(false)
    expect(view.getByRole('button', { name: 'Add panel' })).toBeTruthy()
  })
})
