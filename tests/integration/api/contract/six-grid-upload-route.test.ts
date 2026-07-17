import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { ApiError } from '@/lib/api-errors'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  SixGridUploadError,
} from '@/lib/novel-promotion/six-grid/upload-contract'
import { ROUTE_CATALOG } from '../../../contracts/route-catalog'

const authMock = vi.hoisted(() => vi.fn())
const loadOwnedSixGridMock = vi.hoisted(() => vi.fn())
const assertAvailableMock = vi.hoisted(() => vi.fn())
const replaceSheetMock = vi.hoisted(() => vi.fn())
const validateUploadMock = vi.hoisted(() => vi.fn())
const uploadObjectMock = vi.hoisted(() => vi.fn())
const ensureMediaMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: authMock,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))

vi.mock('@/lib/novel-promotion/six-grid/image-task-route', () => ({
  loadOwnedSixGrid: loadOwnedSixGridMock,
}))

vi.mock('@/lib/novel-promotion/six-grid/upload-service', () => ({
  assertSixGridUploadAvailable: assertAvailableMock,
  replaceSixGridSheet: replaceSheetMock,
}))

vi.mock('@/lib/novel-promotion/six-grid/upload-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/novel-promotion/six-grid/upload-validation')>()
  validateUploadMock.mockImplementation(actual.validateAndNormalizeSixGridUpload)
  return {
    ...actual,
    validateAndNormalizeSixGridUpload: validateUploadMock,
  }
})

vi.mock('@/lib/storage', () => ({ uploadObject: uploadObjectMock }))
vi.mock('@/lib/media/service', () => ({ ensureMediaObjectFromStorageKey: ensureMediaMock }))

const routeFile = 'src/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route.ts'
const routeUrl = 'http://localhost/api/novel-promotion/project-1/storyboard-sheet/upload'
const multipartEnvelopeAllowanceBytes = 256 * 1024

type UploadFile = File & { arrayBuffer: ReturnType<typeof vi.fn> }

function makeFile(bytes: Buffer, name = 'sheet.png', type = 'image/png'): UploadFile {
  const file = new File([Uint8Array.from(bytes).buffer], name, { type })
  const read = vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  Object.defineProperty(file, 'arrayBuffer', { value: read })
  return file as UploadFile
}

function makeForm(input: {
  file?: File
  episodeId?: string
  storyboardId?: string
  expectedSheetArtifactVersion?: string
} = {}): FormData {
  const form = new FormData()
  if (input.file) form.append('file', input.file)
  if (input.episodeId !== undefined) form.append('episodeId', input.episodeId)
  if (input.storyboardId !== undefined) form.append('storyboardId', input.storyboardId)
  if (input.expectedSheetArtifactVersion !== undefined) {
    form.append('expectedSheetArtifactVersion', input.expectedSheetArtifactVersion)
  }
  return form
}

function validForm(file: File): FormData {
  return makeForm({
    file,
    episodeId: '  episode-1  ',
    storyboardId: '  storyboard-1  ',
    expectedSheetArtifactVersion: '4',
  })
}

function makeRequest(form: FormData, headers?: {
  contentType?: string | null
  contentLength?: string | null
}): {
  request: NextRequest
  parseFormData: ReturnType<typeof vi.fn>
} {
  const requestHeaders = new Headers({
    'content-type': 'multipart/form-data; boundary=test-boundary',
    'content-length': '1024',
  })
  if (headers?.contentType === null) requestHeaders.delete('content-type')
  else if (headers?.contentType !== undefined) requestHeaders.set('content-type', headers.contentType)
  if (headers?.contentLength === null) requestHeaders.delete('content-length')
  else if (headers?.contentLength !== undefined) requestHeaders.set('content-length', headers.contentLength)

  const request = new NextRequest(routeUrl, { method: 'POST', headers: requestHeaders })
  const parseFormData = vi.fn(async () => form)
  Object.defineProperty(request, 'formData', { value: parseFormData })
  return { request, parseFormData }
}

async function makeSerializedMultipartRequest(form: FormData): Promise<NextRequest> {
  const encoded = new Response(form)
  const body = await encoded.arrayBuffer()
  const contentType = encoded.headers.get('content-type')
  if (!contentType) throw new Error('serialized multipart content type missing')
  return new NextRequest(routeUrl, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
    },
    body,
  })
}

async function callUpload(form: FormData): Promise<Response> {
  const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route')
  const { request } = makeRequest(form)
  return route.POST(request, { params: Promise.resolve({ projectId: 'project-1' }) })
}

async function image(format: 'png' | 'jpeg' | 'webp', width = 320, height = 120): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 80, b: 140 },
    },
  })[format]().toBuffer()
}

describe('POST six-grid storyboard sheet upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({ session: { user: { id: 'user-1' } } })
    loadOwnedSixGridMock.mockResolvedValue({
      id: 'storyboard-1',
      layoutMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
      sheetArtifactVersion: 4,
    })
    assertAvailableMock.mockResolvedValue(undefined)
    uploadObjectMock.mockResolvedValue('unused-storage-url')
    ensureMediaMock.mockResolvedValue({
      id: 'media-upload-1',
      url: '/api/files/images/six-grid/upload.webp',
    })
    replaceSheetMock.mockResolvedValue({
      mediaId: 'media-upload-1',
      url: '/api/files/images/six-grid/upload.webp',
      sheetArtifactVersion: 5,
    })
  })

  it('authenticates before parsing multipart data or decoding bytes', async () => {
    const authResponse = NextResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
    authMock.mockResolvedValueOnce(authResponse)
    const file = makeFile(Buffer.from('must-not-read'))
    const { request, parseFormData } = makeRequest(validForm(file))
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route')

    const response = await route.POST(request, { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'AUTH_REQUIRED' })
    expect(authMock).toHaveBeenCalledWith('project-1')
    expect(parseFormData).not.toHaveBeenCalled()
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
    expect(validateUploadMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
    expect(replaceSheetMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing content type', { contentType: null }, 'body'],
    ['wrong content type', { contentType: 'application/json' }, 'body'],
    ['missing multipart boundary', { contentType: 'multipart/form-data' }, 'body'],
    ['empty multipart boundary', { contentType: 'multipart/form-data; boundary=' }, 'body'],
    ['missing content length', { contentLength: null }, 'content-length'],
    ['fractional content length', { contentLength: '12.5' }, 'content-length'],
    ['negative content length', { contentLength: '-1' }, 'content-length'],
    ['duplicate content length', { contentLength: '12, 12' }, 'content-length'],
    ['unsafe content length', { contentLength: '9007199254740992' }, 'content-length'],
  ] as const)('rejects %s before parsing multipart data', async (_label, headers, field) => {
    const file = makeFile(Buffer.from('must-not-read'))
    const { request, parseFormData } = makeRequest(validForm(file), headers)
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route')

    const response = await route.POST(request, { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: { code: 'SIX_GRID_UPLOAD_PAYLOAD_INVALID', field },
      },
    })
    expect(parseFormData).not.toHaveBeenCalled()
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
    expect(validateUploadMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized multipart body before formData materializes it', async () => {
    const file = makeFile(Buffer.from('must-not-read'))
    const contentLength = SIX_GRID_UPLOAD_MAX_BYTES + multipartEnvelopeAllowanceBytes + 1
    const { request, parseFormData } = makeRequest(validForm(file), {
      contentLength: String(contentLength),
    })
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route')

    const response = await route.POST(request, { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { details: { code: 'SIX_GRID_UPLOAD_TOO_LARGE', field: 'content-length' } },
    })
    expect(parseFormData).not.toHaveBeenCalled()
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
  })

  it('parses an actually serialized multipart NextRequest', async () => {
    const request = await makeSerializedMultipartRequest(validForm(makeFile(await image('png'))))
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route')

    const response = await route.POST(request, { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(loadOwnedSixGridMock).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardId: 'storyboard-1',
    })
    expect(validateUploadMock).toHaveBeenCalledWith(expect.any(Buffer), '16:9')
  })

  it.each([
    ['file', makeForm({ episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '4' })],
    ['episodeId', makeForm({ file: makeFile(Buffer.from('x')), storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '4' })],
    ['storyboardId', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', expectedSheetArtifactVersion: '4' })],
    ['expectedSheetArtifactVersion', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', storyboardId: 'storyboard-1' })],
    ['expectedSheetArtifactVersion', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '   ' })],
    ['expectedSheetArtifactVersion', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '-1' })],
    ['expectedSheetArtifactVersion', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '1.5' })],
    ['expectedSheetArtifactVersion', makeForm({ file: makeFile(Buffer.from('x')), episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '9007199254740992' })],
    ['episodeId', makeForm({ file: makeFile(Buffer.from('x')), episodeId: '   ', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: '4' })],
  ])('rejects an invalid %s field with stable payload details', async (field, form) => {
    const response = await callUpload(form)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: { code: 'SIX_GRID_UPLOAD_PAYLOAD_INVALID', field },
      },
    })
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate required values instead of accepting a bypass value', async () => {
    const file = makeFile(Buffer.from('x'))
    const form = validForm(file)
    form.append('expectedSheetArtifactVersion', '-1')

    const response = await callUpload(form)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { details: { code: 'SIX_GRID_UPLOAD_PAYLOAD_INVALID', field: 'expectedSheetArtifactVersion' } },
    })
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
  })

  it('rejects the declared file size before ownership lookup or arrayBuffer', async () => {
    const file = makeFile(Buffer.from('small'))
    Object.defineProperty(file, 'size', { value: SIX_GRID_UPLOAD_MAX_BYTES + 1 })

    const response = await callUpload(validForm(file))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { details: { code: 'SIX_GRID_UPLOAD_TOO_LARGE', field: 'file' } },
    })
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(loadOwnedSixGridMock).not.toHaveBeenCalled()
    expect(assertAvailableMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
  })

  it.each(['png', 'jpeg', 'webp'] as const)('accepts decoded %s bytes and normalizes them to WebP', async (format) => {
    const source = await image(format)
    const file = makeFile(source, `attacker/../../sheet.exe`, 'application/octet-stream')

    const response = await callUpload(validForm(file))

    expect(response.status).toBe(200)
    expect(validateUploadMock).toHaveBeenCalledWith(expect.any(Buffer), '16:9')
    const [uploaded] = uploadObjectMock.mock.calls[0] as [Buffer, string, number, string]
    expect((await sharp(uploaded).metadata()).format).toBe('webp')
  })

  it('loads the owned storyboard and checks availability before reading bytes or storing data', async () => {
    const file = makeFile(await image('png'))

    const response = await callUpload(validForm(file))

    expect(response.status).toBe(200)
    expect(loadOwnedSixGridMock).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardId: 'storyboard-1',
    })
    expect(loadOwnedSixGridMock.mock.invocationCallOrder[0]).toBeLessThan(assertAvailableMock.mock.invocationCallOrder[0])
    expect(assertAvailableMock).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardId: 'storyboard-1',
    })
    expect(assertAvailableMock.mock.invocationCallOrder[0]).toBeLessThan(file.arrayBuffer.mock.invocationCallOrder[0])
    expect(file.arrayBuffer.mock.invocationCallOrder[0]).toBeLessThan(uploadObjectMock.mock.invocationCallOrder[0])
  })

  it.each([
    ['busy', assertAvailableMock, new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_BUSY' })],
    ['stale', replaceSheetMock, new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })],
  ])('preserves the %s conflict response', async (_label, boundary, error) => {
    boundary.mockRejectedValueOnce(error)
    const file = makeFile(await image('png'))

    const response = await callUpload(validForm(file))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { code: error.details?.code } },
    })
    if (boundary === assertAvailableMock) {
      expect(file.arrayBuffer).not.toHaveBeenCalled()
      expect(uploadObjectMock).not.toHaveBeenCalled()
    }
  })

  it('does not read or store bytes when storyboard ownership is rejected', async () => {
    loadOwnedSixGridMock.mockRejectedValueOnce(new ApiError('NOT_FOUND', { code: 'SIX_GRID_STORYBOARD_NOT_FOUND' }))
    const file = makeFile(await image('png'))

    const response = await callUpload(validForm(file))

    expect(response.status).toBe(404)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(assertAvailableMock).not.toHaveBeenCalled()
    expect(validateUploadMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
    expect(ensureMediaMock).not.toHaveBeenCalled()
    expect(replaceSheetMock).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid image', async () => Buffer.from('not an image'), 'SIX_GRID_UPLOAD_IMAGE_INVALID'],
    ['wrong ratio', async () => image('png', 100, 100), 'SIX_GRID_UPLOAD_RATIO_INVALID'],
    ['decoded image too large', async () => image('png', 16_385, 1), 'SIX_GRID_UPLOAD_TOO_LARGE'],
  ])('maps %s failures without leaking decoder details', async (_label, bytes, code) => {
    const file = makeFile(await bytes())

    const response = await callUpload(validForm(file))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ error: { code: 'INVALID_PARAMS', details: { code } } })
    expect(JSON.stringify(body)).not.toMatch(/sharp|input buffer|decoder/i)
    expect(uploadObjectMock).not.toHaveBeenCalled()
    expect(ensureMediaMock).not.toHaveBeenCalled()
    expect(replaceSheetMock).not.toHaveBeenCalled()
  })

  it('maps a validator upload error to stable invalid parameters details', async () => {
    validateUploadMock.mockRejectedValueOnce(new SixGridUploadError('SIX_GRID_UPLOAD_RATIO_INVALID', {
      width: 100,
      height: 100,
      actualRatio: 1,
    }))

    const response = await callUpload(validForm(makeFile(Buffer.from('bytes'))))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        details: {
          code: 'SIX_GRID_UPLOAD_RATIO_INVALID',
          field: 'file',
          details: { width: 100, height: 100, actualRatio: 1 },
        },
      },
    })
  })

  it.each([
    ['validator', validateUploadMock],
    ['storage', uploadObjectMock],
    ['media service', ensureMediaMock],
    ['replacement', replaceSheetMock],
  ])('sanitizes an unknown %s infrastructure error', async (label, boundary) => {
    const sentinel = `SECRET_${label.replaceAll(' ', '_').toUpperCase()}_/private/path/P2034`
    boundary.mockRejectedValueOnce(new Error(sentinel))

    const response = await callUpload(validForm(makeFile(await image('png'))))
    const responseText = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(responseText)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
    expect(responseText).not.toContain(sentinel)
  })

  it('stores normalized bytes under a scoped safe WebP key and returns only public fields', async () => {
    const file = makeFile(await image('jpeg'), '../../../../attacker-name.png', 'image/png')

    const response = await callUpload(validForm(file))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual([
      'height',
      'sheetArtifactVersion',
      'sheetImageMediaId',
      'sheetImageUrl',
      'width',
    ])
    expect(body).toEqual({
      sheetImageMediaId: 'media-upload-1',
      sheetImageUrl: '/api/files/images/six-grid/upload.webp',
      width: 320,
      height: 120,
      sheetArtifactVersion: 5,
    })

    const [normalized, key, retries, contentType] = uploadObjectMock.mock.calls[0] as [Buffer, string, number, string]
    expect(Buffer.isBuffer(normalized)).toBe(true)
    expect(key).toMatch(/user-1.*project-1.*\.webp$/)
    expect(key).not.toContain('attacker-name')
    expect(retries).toBe(1)
    expect(contentType).toBe('image/webp')
    expect(ensureMediaMock).toHaveBeenCalledWith(key, {
      mimeType: 'image/webp',
      sizeBytes: normalized.byteLength,
      width: 320,
      height: 120,
    })
    expect(replaceSheetMock).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardId: 'storyboard-1',
      expectedSheetArtifactVersion: 4,
      media: {
        id: 'media-upload-1',
        url: '/api/files/images/six-grid/upload.webp',
      },
    })
  })

  it('registers the upload endpoint as a CRUD novel-promotion route', () => {
    expect(ROUTE_CATALOG).toContainEqual({
      routeFile,
      category: 'novel-promotion',
      contractGroup: 'crud-novel-promotion-routes',
    })
  })
})
