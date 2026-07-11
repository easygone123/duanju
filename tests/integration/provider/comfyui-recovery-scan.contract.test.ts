import { describe, expect, it, vi } from 'vitest'

import {
  recoverExpiredPreSubmitCandidateWithStore,
  scanExpiredPreSubmitComfyRequests,
  type ExpiredPreSubmitCandidate,
} from '@/lib/comfyui/recovery-scan'
import { comfyRequestLeaseValue } from '@/lib/comfyui/lease'

function candidate(status: ExpiredPreSubmitCandidate['status'] = 'uploading'): ExpiredPreSubmitCandidate {
  return {
    id: `request-${status}`, userId: 'user-1', connectionId: `connection-${status}`,
    leaseId: `lease-${status}`, leaseExpiresAt: new Date(1_000), status,
  }
}

describe('ComfyUI expired pre-submit recovery scan', () => {
  it('recovers expired pre-submit phases only after Redis TTL ownership disappears', async () => {
    const candidates = [candidate('leased'), candidate('uploading'), candidate('submitting')]
    const recoverCandidate = vi.fn().mockResolvedValue(true)
    const releaseLease = vi.fn().mockResolvedValue(true)
    const readLeaseValue = vi.fn().mockResolvedValue(null)

    const result = await scanExpiredPreSubmitComfyRequests({ now: new Date(2_000), limit: 10 }, {
      listExpiredCandidates: vi.fn().mockResolvedValue(candidates), readLeaseValue,
      recoverCandidate, releaseLease,
    })

    expect(result).toEqual({ scanned: 3, recovered: 3, contended: 0, lost: 0 })
    expect(recoverCandidate).toHaveBeenCalledTimes(3)
    expect(releaseLease).toHaveBeenCalledTimes(3)
  })

  it('waits for an exact heartbeat owner to expire before entering DB recovery', async () => {
    const expired = candidate('uploading')
    const recoverCandidate = vi.fn().mockResolvedValue(true)
    const releaseLease = vi.fn().mockResolvedValue(true)
    const readLeaseValue = vi.fn()
      .mockResolvedValueOnce(comfyRequestLeaseValue({
        requestId: expired.id, leaseId: expired.leaseId,
      }))
      .mockResolvedValueOnce(null)
    const dependencies = {
      listExpiredCandidates: vi.fn().mockResolvedValue([expired]),
      readLeaseValue, recoverCandidate, releaseLease,
    }

    await expect(scanExpiredPreSubmitComfyRequests({ now: new Date(2_000) }, dependencies))
      .resolves.toEqual({ scanned: 1, recovered: 0, contended: 1, lost: 0 })
    expect(recoverCandidate).not.toHaveBeenCalled()
    expect(releaseLease).not.toHaveBeenCalled()

    await expect(scanExpiredPreSubmitComfyRequests({ now: new Date(2_000) }, dependencies))
      .resolves.toEqual({ scanned: 1, recovered: 1, contended: 0, lost: 0 })
    expect(recoverCandidate).toHaveBeenCalledOnce()
    expect(releaseLease).toHaveBeenCalledOnce()
  })

  it('fails closed when Redis has a new owner and never touches the DB', async () => {
    const recoverCandidate = vi.fn()
    const releaseLease = vi.fn()
    const result = await scanExpiredPreSubmitComfyRequests({ now: new Date(2_000) }, {
      listExpiredCandidates: vi.fn().mockResolvedValue([candidate()]),
      readLeaseValue: vi.fn().mockResolvedValue(comfyRequestLeaseValue({
        requestId: 'new-request', leaseId: 'new-lease',
      })),
      recoverCandidate, releaseLease,
    })

    expect(result).toEqual({ scanned: 1, recovered: 0, contended: 1, lost: 0 })
    expect(recoverCandidate).not.toHaveBeenCalled()
    expect(releaseLease).not.toHaveBeenCalled()
  })

  it('uses connection competition and exact owner/expiry CAS before clearing the lease', async () => {
    const updateRequest = vi.fn().mockResolvedValue({ count: 1 })
    const store = {
      transaction: async <T>(operation: (client: {
        countCompeting(connectionId: string, requestId: string): Promise<number>
        updateRequest(input: Record<string, unknown>): Promise<{ count: number }>
      }) => Promise<T>) => operation({ countCompeting: vi.fn().mockResolvedValue(0), updateRequest }),
    }
    await expect(recoverExpiredPreSubmitCandidateWithStore(candidate(), new Date(2_000), store))
      .resolves.toBe(true)
    expect(updateRequest).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'request-uploading', userId: 'user-1', connectionId: 'connection-uploading',
        leaseId: 'lease-uploading', leaseExpiresAt: { lte: new Date(1_000) }, promptId: null,
        submissionAttempts: { none: {} },
      }),
      data: expect.objectContaining({
        status: 'waiting_capacity', connectionId: null, leaseId: null, leaseExpiresAt: null,
      }),
    })

    const blockedUpdate = vi.fn()
    const blockedStore = {
      transaction: async <T>(operation: (client: {
        countCompeting(connectionId: string, requestId: string): Promise<number>
        updateRequest(input: Record<string, unknown>): Promise<{ count: number }>
      }) => Promise<T>) => operation({ countCompeting: vi.fn().mockResolvedValue(1), updateRequest: blockedUpdate }),
    }
    await expect(recoverExpiredPreSubmitCandidateWithStore(candidate(), new Date(2_000), blockedStore))
      .resolves.toBe(false)
    expect(blockedUpdate).not.toHaveBeenCalled()
  })
})
