// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  VirtualCardRange,
  computeInitialVirtualRange,
  computeVirtualRange,
  useVirtualCardRetention,
} from '@/components/virtualization/VirtualCardRange'

beforeEach(() => {
  Reflect.set(globalThis, 'React', React)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'ResizeObserver')
})

describe('workspace virtual card range', () => {
  it('uses a deterministic server/client initial range before measuring the viewport', () => {
    expect(computeInitialVirtualRange(100, 720, 1)).toEqual({ start: 0, end: 2 })
  })

  it('mounts a bounded range for 600 cards', () => {
    const range = computeVirtualRange({
      count: 600,
      scrollTop: 4200,
      viewportHeight: 900,
      estimatedRowHeight: 420,
      overscan: 2,
    })

    expect(range.end - range.start).toBeLessThanOrEqual(10)
    expect(range.start).toBeGreaterThan(0)
    expect(range.end).toBeLessThan(600)
  })

  it('renders card bodies only inside the range while keeping stable offscreen spacers', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `card-${index}` }))
    const view = render(React.createElement(VirtualCardRange<{ id: string }>, {
      items,
      range: { start: 10, end: 16 },
      pinnedIndices: [90],
      estimatedCardHeight: 420,
      getKey: (item: { id: string }) => item.id,
      renderCard: (item: { id: string }) => React.createElement('article', null, item.id),
    }))

    expect(view.getAllByTestId('virtual-card-body')).toHaveLength(7)
    expect(view.getAllByTestId('virtual-card-spacer')).toHaveLength(93)
    expect(view.getByText('card-90')).toBeTruthy()
    const firstSpacer = view.container.querySelector<HTMLElement>('[data-virtual-card-key="card-0"]')
    expect(firstSpacer?.style.minHeight).toBe('420px')
  })

  it('clamps responsive grid ranges and includes complete rows', () => {
    expect(computeVirtualRange({
      count: 21,
      scrollTop: 800,
      viewportHeight: 600,
      estimatedRowHeight: 400,
      overscan: 1,
      columnCount: 3,
    })).toEqual({ start: 3, end: 15 })

    expect(computeVirtualRange({
      count: 2,
      scrollTop: 9_999,
      viewportHeight: 600,
      estimatedRowHeight: 400,
      overscan: 1,
      columnCount: 5,
    })).toEqual({ start: 0, end: 2 })
  })

  it('uses measured row heights so a tall mounted group cannot create a blank viewport', () => {
    expect(computeVirtualRange({
      count: 5,
      scrollTop: 3000,
      viewportHeight: 900,
      estimatedRowHeight: 960,
      overscan: 0,
      rowHeights: [4000, 960, 960, 960, 960],
    })).toEqual({ start: 0, end: 1 })
  })

  it('reuses a measured card height when that card moves offscreen', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Reflect.set(globalThis, 'ResizeObserver', ResizeObserverMock)
    const items = [{ id: 'card-0' }, { id: 'card-1' }, { id: 'card-2' }]
    const props = {
      items,
      estimatedCardHeight: 420,
      getKey: (item: { id: string }) => item.id,
      renderCard: (item: { id: string }) => React.createElement('article', null, item.id),
    }
    const view = render(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 0, end: 1 },
    }))
    const firstWrapper = view.container.querySelector<HTMLElement>('[data-virtual-card-index="0"]')!

    act(() => {
      for (const callback of resizeCallbacks) {
        callback([{
          target: firstWrapper,
          contentRect: { height: 612 },
        } as unknown as ResizeObserverEntry], {} as ResizeObserver)
      }
    })
    view.rerender(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 2, end: 3 },
    }))

    const measuredSpacer = view.container.querySelector<HTMLElement>('[data-virtual-card-key="card-0"]')
    expect(measuredSpacer?.style.minHeight).toBe('612px')
  })

  it('does not permanently retain ordinary pointer interactions', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}` }))
    const props = {
      items,
      estimatedCardHeight: 420,
      getKey: (item: { id: string }) => item.id,
      renderCard: (item: { id: string }) => React.createElement('button', null, item.id),
    }
    const view = render(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 0, end: 2 },
    }))
    fireEvent.pointerDown(view.getByRole('button', { name: 'card-0' }))
    fireEvent.pointerDown(view.getByRole('button', { name: 'card-1' }))
    view.rerender(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 4, end: 6 },
    }))

    expect(view.queryByRole('button', { name: 'card-1' })).toBeNull()
    expect(view.queryByRole('button', { name: 'card-0' })).toBeNull()
  })

  it('keeps a keyboard-focused card mounted when it leaves the viewport', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}` }))
    const props = {
      items,
      estimatedCardHeight: 420,
      getKey: (item: { id: string }) => item.id,
      renderCard: (item: { id: string }) => React.createElement('button', null, item.id),
    }
    const view = render(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 0, end: 2 },
    }))
    fireEvent.focus(view.getByRole('button', { name: 'card-0' }))
    view.rerender(React.createElement(VirtualCardRange<{ id: string }>, {
      ...props,
      range: { start: 4, end: 6 },
    }))

    expect(view.getByRole('button', { name: 'card-0' })).toBeTruthy()

    fireEvent.blur(view.getByRole('button', { name: 'card-0' }), { relatedTarget: document.body })
    expect(view.queryByRole('button', { name: 'card-0' })).toBeNull()
  })

  it('retains explicitly dirty cards and releases them after edits finish', () => {
    function DirtyCard({ id, dirty }: { id: string; dirty: boolean }) {
      useVirtualCardRetention(dirty)
      return React.createElement('article', null, id)
    }
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}` }))
    const cardProps = (dirty: boolean) => ({
      items,
      estimatedCardHeight: 420,
      getKey: (item: { id: string }) => item.id,
      renderCard: (item: { id: string }) => React.createElement(DirtyCard, {
        id: item.id,
        dirty: dirty && item.id === 'card-0',
      }),
    })
    const view = render(React.createElement(VirtualCardRange<{ id: string }>, {
      ...cardProps(true),
      range: { start: 0, end: 2 },
    }))
    view.rerender(React.createElement(VirtualCardRange<{ id: string }>, {
      ...cardProps(true),
      range: { start: 4, end: 6 },
    }))
    expect(view.getByText('card-0')).toBeTruthy()

    view.rerender(React.createElement(VirtualCardRange<{ id: string }>, {
      ...cardProps(false),
      range: { start: 4, end: 6 },
    }))
    expect(view.queryByText('card-0')).toBeNull()
  })

  it('keeps retention active until every nested editor releases its own token', () => {
    function CardWithEditors({ first, second }: { first: boolean; second: boolean }) {
      useVirtualCardRetention(first)
      useVirtualCardRetention(second)
      return React.createElement('article', null, 'card-0')
    }
    const renderCard = (first: boolean, second: boolean) => React.createElement(
      VirtualCardRange<{ id: string }>,
      {
        items: [{ id: 'card-0' }, { id: 'card-1' }],
        estimatedCardHeight: 420,
        getKey: (item) => item.id,
        renderCard: (item) => item.id === 'card-0'
          ? React.createElement(CardWithEditors, { first, second })
          : React.createElement('article', null, item.id),
        range: { start: 0, end: 1 },
      },
    )
    const view = render(renderCard(true, false))
    view.rerender(React.cloneElement(renderCard(false, true), {
      range: { start: 1, end: 2 },
    }))
    expect(view.getByText('card-0')).toBeTruthy()

    view.rerender(React.cloneElement(renderCard(false, false), {
      range: { start: 1, end: 2 },
    }))
    expect(view.queryByText('card-0')).toBeNull()
  })
})
