// @vitest-environment jsdom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: (input: React.ImgHTMLAttributes<HTMLImageElement> & {
    priority?: boolean
    fill?: boolean
  }) => {
    const props = { ...input }
    delete props.priority
    delete props.fill
    return React.createElement('img', props)
  },
}))

import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import ImagePreviewModal from '@/components/ui/ImagePreviewModal'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  Reflect.set(globalThis, 'React', React)
})

afterEach(() => cleanup())

describe('workspace lazy media', () => {
  it('loads stable media lazily and preserves responsive sizes', () => {
    const view = render(React.createElement(MediaImageWithLoading, {
      src: '/m/media-1',
      alt: 'panel thumbnail',
      sizes: '(max-width: 768px) 100vw, 33vw',
    }))
    const image = view.getByAltText('panel thumbnail')

    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('sizes')).toBe('(max-width: 768px) 100vw, 33vw')
  })

  it('uses eager loading only for explicitly prioritized media', () => {
    const view = render(React.createElement(MediaImageWithLoading, {
      src: '/m/hero',
      alt: 'hero',
      priority: true,
    }))

    expect(view.getByAltText('hero').getAttribute('loading')).toBe('eager')
  })

  it('exposes the original media URL only after the explicit preview opens', () => {
    const closed = render(React.createElement(ImagePreviewModal, {
      imageUrl: null,
      onClose: vi.fn(),
    }))
    expect(closed.queryByRole('link', { name: 'viewOriginal' })).toBeNull()
    closed.unmount()

    const opened = render(React.createElement(ImagePreviewModal, {
      imageUrl: '/_next/image?url=images%2Foriginal.png&w=640&q=75',
      onClose: vi.fn(),
    }))
    expect(opened.getByRole('link', { name: 'viewOriginal' }).getAttribute('href'))
      .toBe('/api/storage/sign?key=images%2Foriginal.png')
  })
})
