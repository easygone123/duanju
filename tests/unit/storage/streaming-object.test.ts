import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type MockCommand = {
  readonly type: 'PutObjectCommand' | 'GetObjectCommand'
  readonly input: Record<string, unknown>
}

const {
  createStorageProviderMock,
  facadeGetObjectStreamMock,
  facadeUploadObjectStreamMock,
  getObjectCommandMock,
  putObjectCommandMock,
  s3ClientMock,
  sendMock,
} = vi.hoisted(() => {
  const facadeUploadObjectStream = vi.fn()
  const facadeGetObjectStream = vi.fn()

  return {
    createStorageProviderMock: vi.fn(() => ({
      kind: 'local' as const,
      uploadObject: vi.fn(),
      uploadObjectStream: facadeUploadObjectStream,
      deleteObject: vi.fn(),
      deleteObjects: vi.fn(),
      getSignedObjectUrl: vi.fn(),
      getObjectBuffer: vi.fn(),
      getObjectStream: facadeGetObjectStream,
      extractStorageKey: vi.fn(),
      toFetchableUrl: vi.fn(),
      generateUniqueKey: vi.fn(),
    })),
    facadeGetObjectStreamMock: facadeGetObjectStream,
    facadeUploadObjectStreamMock: facadeUploadObjectStream,
    getObjectCommandMock: vi.fn((input: Record<string, unknown>): MockCommand => ({
      type: 'GetObjectCommand',
      input,
    })),
    putObjectCommandMock: vi.fn((input: Record<string, unknown>): MockCommand => ({
      type: 'PutObjectCommand',
      input,
    })),
    s3ClientMock: vi.fn(),
    sendMock: vi.fn<(command: MockCommand) => Promise<unknown>>(),
  }
})

s3ClientMock.mockImplementation(() => ({ send: sendMock }))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: s3ClientMock,
  PutObjectCommand: putObjectCommandMock,
  GetObjectCommand: getObjectCommandMock,
}))

vi.mock('@/lib/storage/factory', () => ({
  createStorageProvider: createStorageProviderMock,
}))

import * as storageFacade from '@/lib/storage'
import { MinioStorageProvider } from '@/lib/storage/providers/minio'

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('LocalStorageProvider streaming objects', () => {
  const uploadDirectory = path.join('data', `streaming-storage-test-${randomUUID()}`)
  const uploadRoot = path.join(process.cwd(), uploadDirectory)
  let LocalStorageProvider: typeof import('@/lib/storage/providers/local').LocalStorageProvider

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDirectory
    ;({ LocalStorageProvider } = await import('@/lib/storage/providers/local'))
  })

  afterAll(async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true })
  })

  it('writes exact bytes atomically and leaves no sibling part file', async () => {
    const provider = new LocalStorageProvider()
    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255])

    await expect(provider.uploadObjectStream({
      key: '/nested/video.bin',
      body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
      contentLength: bytes.length,
      contentType: 'application/octet-stream',
    })).resolves.toEqual({ key: 'nested/video.bin' })

    expect(await fs.readFile(path.join(uploadRoot, 'nested/video.bin'))).toEqual(bytes)
    expect((await fs.readdir(path.join(uploadRoot, 'nested'))).filter((name) => name.includes('.part-'))).toEqual([])
  })

  it('removes the part file and final file when the input stream fails', async () => {
    const provider = new LocalStorageProvider()
    const inputError = new Error('source stream failed')
    const source = Readable.from((async function* () {
      yield Buffer.from('partial')
      throw inputError
    })())

    await expect(provider.uploadObjectStream({
      key: 'failed/input.bin',
      body: source,
      contentLength: 100,
    })).rejects.toBe(inputError)

    expect(await pathExists(path.join(uploadRoot, 'failed/input.bin'))).toBe(false)
    expect((await fs.readdir(path.join(uploadRoot, 'failed'))).filter((name) => name.includes('.part-'))).toEqual([])
  })

  it('removes the part file when the final rename fails', async () => {
    const provider = new LocalStorageProvider()
    const finalPath = path.join(uploadRoot, 'rename-target')
    await fs.mkdir(finalPath, { recursive: true })

    await expect(provider.uploadObjectStream({
      key: 'rename-target',
      body: Readable.from([Buffer.from('complete')]),
      contentLength: 8,
    })).rejects.toThrow()

    expect((await fs.readdir(uploadRoot)).filter((name) => name.includes('.part-'))).toEqual([])
    expect((await fs.stat(finalPath)).isDirectory()).toBe(true)
  })

  it('returns a readable stream containing the stored bytes', async () => {
    const provider = new LocalStorageProvider()
    const filePath = path.join(uploadRoot, 'downloads/video.bin')
    const bytes = Buffer.from('stream me without buffering')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, bytes)

    const stream = await provider.getObjectStream('/downloads/video.bin')

    await expect(streamToBuffer(stream)).resolves.toEqual(bytes)
  })
})

describe('MinioStorageProvider streaming objects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000'
    process.env.MINIO_REGION = 'us-east-1'
    process.env.MINIO_BUCKET = 'waoowaoo'
    process.env.MINIO_ACCESS_KEY = 'minioadmin'
    process.env.MINIO_SECRET_KEY = 'minioadmin'
    process.env.MINIO_FORCE_PATH_STYLE = 'true'
    s3ClientMock.mockImplementation(() => ({ send: sendMock }))
  })

  it('uploads the original stream with its declared metadata', async () => {
    const provider = new MinioStorageProvider()
    const body = Readable.from([Buffer.from('video')])
    sendMock.mockResolvedValueOnce({})

    await expect(provider.uploadObjectStream({
      key: 'viral/source.mp4',
      body,
      contentLength: 5,
      contentType: 'video/mp4',
    })).resolves.toEqual({ key: 'viral/source.mp4' })

    expect(putObjectCommandMock).toHaveBeenCalledWith({
      Bucket: 'waoowaoo',
      Key: 'viral/source.mp4',
      Body: body,
      ContentLength: 5,
      ContentType: 'video/mp4',
    })
  })

  it('returns a pipeable object body without buffering it', async () => {
    const provider = new MinioStorageProvider()
    const body = Readable.from([Buffer.from('video')])
    sendMock.mockResolvedValueOnce({ Body: body })

    await expect(provider.getObjectStream('viral/source.mp4')).resolves.toBe(body)
    expect(getObjectCommandMock).toHaveBeenCalledWith({
      Bucket: 'waoowaoo',
      Key: 'viral/source.mp4',
    })
  })

  it.each([
    ['missing', {}],
    ['non-pipeable', { Body: { transformToByteArray: vi.fn() } }],
  ])('rejects a %s object body clearly', async (_label, result) => {
    const provider = new MinioStorageProvider()
    sendMock.mockResolvedValueOnce(result)

    await expect(provider.getObjectStream('viral/source.mp4')).rejects.toThrow(/readable stream/i)
  })
})

describe('storage facade streaming objects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    facadeUploadObjectStreamMock.mockResolvedValue({ key: 'viral/source.mp4' })
  })

  it('delegates uploads with the original stream and content length', async () => {
    const body = Readable.from([Buffer.from('video')])

    await expect(storageFacade.uploadObjectStream(
      body,
      'viral/source.mp4',
      5,
      'video/mp4',
      1,
    )).resolves.toBe('viral/source.mp4')

    expect(facadeUploadObjectStreamMock).toHaveBeenCalledWith({
      key: 'viral/source.mp4',
      body,
      contentLength: 5,
      contentType: 'video/mp4',
    })
  })

  it('returns the provider download stream unchanged', async () => {
    const body = Readable.from([Buffer.from('video')])
    facadeGetObjectStreamMock.mockResolvedValueOnce(body)

    await expect(storageFacade.getObjectStream('viral/source.mp4')).resolves.toBe(body)
  })
})
