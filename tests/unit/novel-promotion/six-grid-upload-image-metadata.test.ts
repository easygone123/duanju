import { describe, expect, it } from 'vitest'

import { parseSixGridUploadImageMetadata } from '@/lib/novel-promotion/six-grid/upload-image-metadata'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number, orientation?: number, sofMarker = 0xc0): Uint8Array {
  const app1 = orientation == null ? [] : [
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]
  return Uint8Array.from([
    0xff, 0xd8,
    ...app1,
    0xff, sofMarker, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

function webpChunk(kind: string, payload: number[]): Uint8Array {
  const padded = payload.length + (payload.length % 2)
  const bytes = new Uint8Array(12 + 8 + padded)
  const view = new DataView(bytes.buffer)
  bytes.set([...kind].map((value) => value.charCodeAt(0)), 12)
  view.setUint32(16, payload.length, true)
  bytes.set(payload, 20)
  bytes.set([82, 73, 70, 70], 0)
  view.setUint32(4, bytes.length - 8, true)
  bytes.set([87, 69, 66, 80], 8)
  return bytes
}

describe('six-grid upload encoded image metadata', () => {
  it('reads PNG IHDR dimensions without decoding pixels', () => {
    expect(parseSixGridUploadImageMetadata(png(2400, 900))).toEqual({
      format: 'png', encodedWidth: 2400, encodedHeight: 900,
      width: 2400, height: 900, orientation: 1,
    })
  })

  it('reads JPEG SOF variants and swaps display dimensions for EXIF orientation', () => {
    expect(parseSixGridUploadImageMetadata(jpeg(900, 2400, 6, 0xc2))).toEqual({
      format: 'jpeg', encodedWidth: 900, encodedHeight: 2400,
      width: 2400, height: 900, orientation: 6,
    })
  })

  it('reads WebP VP8, VP8L, and VP8X dimensions', () => {
    const vp8 = webpChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x60, 0x09, 0x84, 0x03])
    const width = 2700 - 1
    const height = 3200 - 1
    const vp8l = webpChunk('VP8L', [0x2f, width & 0xff, ((width >>> 8) & 0x3f) | ((height & 0x03) << 6), (height >>> 2) & 0xff, (height >>> 10) & 0x0f])
    const vp8x = webpChunk('VP8X', [0, 0, 0, 0, 0x5f, 0x09, 0, 0x83, 0x03, 0])

    expect(parseSixGridUploadImageMetadata(vp8)).toMatchObject({ format: 'webp', width: 2400, height: 900 })
    expect(parseSixGridUploadImageMetadata(vp8l)).toMatchObject({ format: 'webp', width: 2700, height: 3200 })
    expect(parseSixGridUploadImageMetadata(vp8x)).toMatchObject({ format: 'webp', width: 2400, height: 900 })
  })

  it('rejects malformed, truncated, and unsupported encoded data', () => {
    expect(() => parseSixGridUploadImageMetadata(new Uint8Array([1, 2, 3]))).toThrow('SIX_GRID_UPLOAD_IMAGE_INVALID')
    expect(() => parseSixGridUploadImageMetadata(png(0, 900))).toThrow('SIX_GRID_UPLOAD_IMAGE_INVALID')
    expect(() => parseSixGridUploadImageMetadata(jpeg(2400, 900).slice(0, 8))).toThrow('SIX_GRID_UPLOAD_IMAGE_INVALID')
    expect(() => parseSixGridUploadImageMetadata(webpChunk('NOPE', [1, 2, 3, 4]))).toThrow('SIX_GRID_UPLOAD_IMAGE_INVALID')
  })
})
