import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VIRAL_UPLOAD_MAX_BYTES } from '@/lib/viral-replication/constants'

export interface WriteRequestBodyToTempFileOptions {
  maxBytes?: number
  prefix?: string
  tempRoot?: string
}

export interface RequestBodyTempFile {
  directory: string
  filePath: string
  sizeBytes: number
  cleanup: () => Promise<void>
}

export async function writeRequestBodyToTempFile(
  body: ReadableStream<Uint8Array> | null,
  options: WriteRequestBodyToTempFileOptions = {},
): Promise<RequestBodyTempFile> {
  if (!body) {
    throw new Error('Request body is required')
  }

  const maxBytes = options.maxBytes ?? VIRAL_UPLOAD_MAX_BYTES
  const tempRoot = options.tempRoot ?? os.tmpdir()
  const prefix = options.prefix ?? 'viral-upload'

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a finite non-negative safe integer')
  }

  await fs.mkdir(tempRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(tempRoot, `${prefix}-`))
  const filePath = path.join(directory, 'request-body')
  let sizeBytes = 0

  const byteCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const nextSize = sizeBytes + chunk.length
      if (nextSize > maxBytes) {
        callback(new Error(`Request body exceeds maximum size of ${maxBytes} bytes`))
        return
      }

      sizeBytes = nextSize
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      byteCounter,
      createWriteStream(filePath),
    )
  } catch (error: unknown) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
    } catch (cleanupError: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AggregateError([error, cleanupError], message)
    }
    throw error
  }

  return {
    directory,
    filePath,
    sizeBytes,
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
