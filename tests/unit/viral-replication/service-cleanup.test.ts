import { describe, expect, it, vi } from 'vitest'
import { cleanupUploadTempFile } from '@/lib/viral-replication/temp-cleanup'

describe('viral upload temp cleanup precedence', () => {
  it.each(['primary failure', 'committed result'])('does not replace a %s with cleanup failure', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
    await expect(cleanupUploadTempFile(cleanup, true)).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reports cleanup failure when it is the only failure', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
    await expect(cleanupUploadTempFile(cleanup, false)).rejects.toThrow('cleanup failed')
  })
})
