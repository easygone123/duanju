// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WorkspaceStageActivityProvider,
  useCloseOnWorkspaceStageInactive,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageActivityContext'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const TestActivityProvider = WorkspaceStageActivityProvider as React.ComponentType<{
  isActive: boolean
  children?: React.ReactNode
}>

function CloseHarness({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const isActive = useCloseOnWorkspaceStageInactive(isOpen, onClose)
  return React.createElement('span', null, isActive && isOpen ? 'visible' : 'hidden')
}

function renderHarness(isActive: boolean, isOpen: boolean, onClose: () => void) {
  return React.createElement(
    TestActivityProvider,
    { isActive },
    React.createElement(CloseHarness, { isOpen, onClose }),
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useCloseOnWorkspaceStageInactive', () => {
  it('closes an initially inactive open state once and remains safe with inline callbacks', async () => {
    const firstClose = vi.fn()
    const ignoredInlineClose = vi.fn()
    const view = render(renderHarness(false, true, () => firstClose()))

    await waitFor(() => expect(firstClose).toHaveBeenCalledOnce())
    expect(view.getByText('hidden')).toBeTruthy()

    view.rerender(renderHarness(false, true, () => ignoredInlineClose()))

    await Promise.resolve()
    expect(firstClose).toHaveBeenCalledOnce()
    expect(ignoredInlineClose).not.toHaveBeenCalled()
  })

  it('resets its inactive close latch after isOpen becomes false and closes a late-open once', async () => {
    const firstClose = vi.fn()
    const lateClose = vi.fn()
    const duplicateClose = vi.fn()
    const view = render(renderHarness(false, true, firstClose))
    await waitFor(() => expect(firstClose).toHaveBeenCalledOnce())

    view.rerender(renderHarness(false, false, vi.fn()))
    view.rerender(renderHarness(false, true, lateClose))
    await waitFor(() => expect(lateClose).toHaveBeenCalledOnce())

    view.rerender(renderHarness(false, true, duplicateClose))
    await Promise.resolve()
    expect(lateClose).toHaveBeenCalledOnce()
    expect(duplicateClose).not.toHaveBeenCalled()
  })
})
