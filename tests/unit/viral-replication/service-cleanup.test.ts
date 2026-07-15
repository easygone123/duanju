import { describe, expect, it, vi } from 'vitest'
import { cleanupUploadTempFile } from '@/lib/viral-replication/temp-cleanup'

describe('viral upload temp cleanup precedence', () => {
  it.each([
    ['primary failure', 'primary_failure'],
    ['committed result', 'committed'],
  ] as const)('does not replace a %s with cleanup failure', async (_label, outcome) => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
    const reporter = vi.fn()
    await expect(cleanupUploadTempFile(cleanup, true, {
      reporter,
      context: { replicationId: 'rep-1', outcome },
    })).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
      action: 'viral.upload.temp_cleanup_failed',
      message: 'viral upload temp file cleanup failed',
      details: { replicationId: 'rep-1', outcome },
      error: expect.objectContaining({ name: 'Error', message: 'cleanup failed' }),
    }))
  })

  it('does not let a warning reporter failure replace the preserved outcome', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
    const reporter = vi.fn(async () => { throw new Error('reporter failed') })
    await expect(cleanupUploadTempFile(cleanup, true, {
      reporter,
      context: { replicationId: 'rep-1', outcome: 'committed' },
    })).resolves.toBeUndefined()
    expect(reporter).toHaveBeenCalledOnce()
  })

  it('reports cleanup failure when it is the only failure', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
    await expect(cleanupUploadTempFile(cleanup, false)).rejects.toThrow('cleanup failed')
  })
})
