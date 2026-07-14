import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRequestBodyToTempFile } from '@/lib/viral-replication/temp-file'

function requestBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('writeRequestBodyToTempFile', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-request-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('preserves exact bytes at the byte limit and reports their count', async () => {
    const expected = Buffer.from([0, 1, 127, 128, 254, 255])

    const result = await writeRequestBodyToTempFile(
      requestBody([expected.subarray(0, 2), expected.subarray(2)]),
      { maxBytes: expected.length, prefix: 'exact-limit', tempRoot },
    )

    expect(result.directory).toBe(path.dirname(result.filePath))
    expect(result.sizeBytes).toBe(expected.length)
    expect(await fs.readFile(result.filePath)).toEqual(expected)
    await result.cleanup()
  })

  it('handles a zero-byte body deterministically', async () => {
    const result = await writeRequestBodyToTempFile(requestBody([]), {
      maxBytes: 0,
      prefix: 'empty',
      tempRoot,
    })

    expect(result.sizeBytes).toBe(0)
    expect(await fs.readFile(result.filePath)).toEqual(Buffer.alloc(0))
    await result.cleanup()
  })

  it('rejects the first chunk that would exceed the limit and leaves no residue', async () => {
    await expect(writeRequestBodyToTempFile(
      requestBody([Buffer.from('1234'), Buffer.from('5')]),
      { maxBytes: 4, prefix: 'too-large', tempRoot },
    )).rejects.toThrow(/exceeds.*4 bytes/i)

    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('rejects a missing request body clearly without creating a directory', async () => {
    await expect(writeRequestBodyToTempFile(null, {
      maxBytes: 4,
      prefix: 'missing',
      tempRoot,
    })).rejects.toThrow(/request body.*required/i)

    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('removes the partial directory when the request stream errors', async () => {
    const streamError = new Error('request disconnected')
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from('partial'))
        controller.error(streamError)
      },
    })

    await expect(writeRequestBodyToTempFile(body, {
      maxBytes: 100,
      prefix: 'stream-error',
      tempRoot,
    })).rejects.toBe(streamError)

    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('returns an idempotent cleanup function', async () => {
    const result = await writeRequestBodyToTempFile(requestBody([Buffer.from('abc')]), {
      maxBytes: 3,
      prefix: 'cleanup',
      tempRoot,
    })

    await expect(result.cleanup()).resolves.toBeUndefined()
    await expect(result.cleanup()).resolves.toBeUndefined()
    expect(await fs.readdir(tempRoot)).toEqual([])
  })
})
