import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MediaImage } from '@/components/media/MediaImage'

describe('workspace media thumbnails', () => {
  it('renders stable media through responsive Next image variants instead of a direct original request', () => {
    Reflect.set(globalThis, 'React', React)
    const html = renderToStaticMarkup(React.createElement(MediaImage, {
      src: '/m/panel-public-id',
      alt: 'panel',
      width: 1200,
      height: 675,
      sizes: '(max-width: 767px) 100vw, 33vw',
    }))

    expect(html).toContain('loading="lazy"')
    expect(html).toContain('srcSet="/_next/image?url=%2Fm%2Fpanel-public-id')
    expect(html).toContain('sizes="(max-width: 767px) 100vw, 33vw"')
    expect(html).not.toContain('src="/m/panel-public-id"')
  })
})
