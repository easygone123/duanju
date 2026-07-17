export interface SixGridUploadImageMetadata {
  format: 'png' | 'jpeg' | 'webp'
  encodedWidth: number
  encodedHeight: number
  width: number
  height: number
  orientation: number
}

const INVALID = 'SIX_GRID_UPLOAD_IMAGE_INVALID'
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function parseSixGridUploadImageMetadata(input: ArrayBuffer | Uint8Array): SixGridUploadImageMetadata {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  try {
    if (isPng(bytes)) return parsePng(bytes)
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes)
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return parseWebp(bytes)
  } catch (error) {
    if (error instanceof Error && error.message === INVALID) throw error
  }
  throw new Error(INVALID)
}

function parsePng(bytes: Uint8Array): SixGridUploadImageMetadata {
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR' || uint32(bytes, 8) !== 13) invalid()
  const width = uint32(bytes, 16)
  const height = uint32(bytes, 20)
  let orientation = 1
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (!Number.isSafeInteger(dataEnd) || dataEnd + 4 > bytes.length) break
    if (ascii(bytes, offset + 4, 4) === 'eXIf') orientation = parseTiffOrientation(bytes.subarray(dataStart, dataEnd))
    offset = dataEnd + 4
  }
  return metadata('png', width, height, orientation)
}

function parseJpeg(bytes: Uint8Array): SixGridUploadImageMetadata {
  let offset = 2
  let width = 0
  let height = 0
  let orientation = 1
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalid()
    while (bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) invalid()
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) invalid()
    const length = uint16(bytes, offset)
    if (length < 2 || offset + length > bytes.length) invalid()
    const dataStart = offset + 2
    const dataEnd = offset + length
    if (marker === 0xe1 && ascii(bytes, dataStart, 6) === 'Exif\0\0') {
      orientation = parseTiffOrientation(bytes.subarray(dataStart + 6, dataEnd))
    }
    if (JPEG_SOF.has(marker)) {
      if (dataStart + 5 > dataEnd) invalid()
      height = uint16(bytes, dataStart + 1)
      width = uint16(bytes, dataStart + 3)
    }
    offset = dataEnd
  }
  return metadata('jpeg', width, height, orientation)
}

function parseWebp(bytes: Uint8Array): SixGridUploadImageMetadata {
  if (bytes.length < 20 || uint32le(bytes, 4) + 8 > bytes.length) invalid()
  let offset = 12
  let width = 0
  let height = 0
  let orientation = 1
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4)
    const length = uint32le(bytes, offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length) invalid()
    if (kind === 'VP8X') {
      if (length < 10) invalid()
      width = uint24le(bytes, dataStart + 4) + 1
      height = uint24le(bytes, dataStart + 7) + 1
    } else if (kind === 'VP8 ') {
      if (length < 10 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) invalid()
      width = uint16le(bytes, dataStart + 6) & 0x3fff
      height = uint16le(bytes, dataStart + 8) & 0x3fff
    } else if (kind === 'VP8L') {
      if (length < 5 || bytes[dataStart] !== 0x2f) invalid()
      width = 1 + bytes[dataStart + 1] + ((bytes[dataStart + 2] & 0x3f) << 8)
      height = 1 + (bytes[dataStart + 2] >>> 6) + (bytes[dataStart + 3] << 2) + ((bytes[dataStart + 4] & 0x0f) << 10)
    } else if (kind === 'EXIF') {
      const exif = ascii(bytes, dataStart, 6) === 'Exif\0\0' ? dataStart + 6 : dataStart
      orientation = parseTiffOrientation(bytes.subarray(exif, dataEnd))
    }
    offset = dataEnd + (length % 2)
  }
  return metadata('webp', width, height, orientation)
}

function parseTiffOrientation(bytes: Uint8Array): number {
  if (bytes.length < 8) return 1
  const littleEndian = ascii(bytes, 0, 2) === 'II'
  if (!littleEndian && ascii(bytes, 0, 2) !== 'MM') return 1
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(2, littleEndian) !== 42) return 1
  const ifdOffset = view.getUint32(4, littleEndian)
  if (ifdOffset + 2 > bytes.length) return 1
  const entries = view.getUint16(ifdOffset, littleEndian)
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12
    if (entry + 12 > bytes.length) return 1
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue
    if (view.getUint16(entry + 2, littleEndian) !== 3 || view.getUint32(entry + 4, littleEndian) !== 1) return 1
    const value = view.getUint16(entry + 8, littleEndian)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

function metadata(format: SixGridUploadImageMetadata['format'], encodedWidth: number, encodedHeight: number, orientation: number): SixGridUploadImageMetadata {
  if (!Number.isSafeInteger(encodedWidth) || !Number.isSafeInteger(encodedHeight) || encodedWidth <= 0 || encodedHeight <= 0) invalid()
  const swap = orientation >= 5 && orientation <= 8
  return {
    format,
    encodedWidth,
    encodedHeight,
    width: swap ? encodedHeight : encodedWidth,
    height: swap ? encodedWidth : encodedHeight,
    orientation,
  }
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function uint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) invalid()
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function uint16le(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) invalid()
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function uint24le(bytes: Uint8Array, offset: number): number {
  if (offset + 3 > bytes.length) invalid()
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function uint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) invalid()
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

function uint32le(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) invalid()
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function invalid(): never {
  throw new Error(INVALID)
}
