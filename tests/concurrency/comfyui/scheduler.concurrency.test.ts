import { describe, expect, it, vi } from 'vitest'

import {
  acquireComfyRequestLease,
  heartbeatDurableComfyRequestLease,
  heartbeatComfyRequestLease,
  releaseComfyRequestLease,
  type ComfyLeaseRedis,
} from '@/lib/comfyui/lease'
import {
  assignComfyRequestWithStore,
  scheduleNextComfyRequest,
  type ComfySchedulableRequest,
  type ComfySchedulerDependencies,
} from '@/lib/comfyui/scheduler'

class MemoryLeaseRedis implements ComfyLeaseRedis {
  readonly values = new Map<string, { value: string; expiresAt: number }>()
  now = 0

  async set(key: string, value: string, _px: 'PX', ttlMs: number) {
    this.expire(key)
    if (this.values.has(key)) return null
    this.values.set(key, { value, expiresAt: this.now + ttlMs })
    return 'OK' as const
  }

  async eval(_script: string, _keyCount: number, key: string, value: string, ttlMs?: number) {
    this.expire(key)
    const current = this.values.get(key)
    if (!current || current.value !== value) return 0
    if (ttlMs !== undefined) current.expiresAt = this.now + Number(ttlMs)
    else this.values.delete(key)
    return 1
  }

  private expire(key: string) {
    const entry = this.values.get(key)
    if (entry && entry.expiresAt <= this.now) this.values.delete(key)
  }
}

describe('ComfyUI request leases', () => {
  it('allows only the owner to heartbeat/release and permits a new owner after expiry', async () => {
    const redis = new MemoryLeaseRedis()
    const owner = { connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-1', ttlMs: 100 }
    await expect(acquireComfyRequestLease(owner, redis)).resolves.toBe(true)
    await expect(acquireComfyRequestLease({ ...owner, requestId: 'request-2', leaseId: 'lease-2' }, redis)).resolves.toBe(false)
    await expect(heartbeatComfyRequestLease({ ...owner, leaseId: 'stale' }, redis)).resolves.toBe(false)
    await expect(releaseComfyRequestLease({ ...owner, leaseId: 'stale' }, redis)).resolves.toBe(false)
    await expect(heartbeatComfyRequestLease(owner, redis)).resolves.toBe(true)

    redis.now = 101
    await expect(acquireComfyRequestLease({ ...owner, requestId: 'request-2', leaseId: 'lease-2' }, redis)).resolves.toBe(true)
  })

  it('heartbeats Redis first and extends the durable owner-CAS expiry for long work', async () => {
    const redis = new MemoryLeaseRedis()
    const owner = { connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-1', ttlMs: 100 }
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    await acquireComfyRequestLease(owner, redis)
    redis.now = 50

    await expect(heartbeatDurableComfyRequestLease(
      owner, { updateMany }, redis, new Date(50),
    )).resolves.toEqual({ owned: true, leaseExpiresAt: new Date(150) })
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'request-1', connectionId: 'connection-1', leaseId: 'lease-1',
        status: { in: [
          'leased', 'uploading', 'submitting', 'submitted', 'running', 'transferring', 'reconciling',
        ] },
      },
      data: { leaseExpiresAt: new Date(150) },
    })
  })

  it('never extends DB expiry for a wrong Redis owner', async () => {
    const redis = new MemoryLeaseRedis()
    const owner = { connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-1', ttlMs: 100 }
    const updateMany = vi.fn()
    await acquireComfyRequestLease(owner, redis)

    await expect(heartbeatDurableComfyRequestLease(
      { ...owner, leaseId: 'wrong' }, { updateMany }, redis, new Date(10),
    )).resolves.toEqual({ owned: false, reason: 'redis_lost' })
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('owner-releases Redis and reports reconciliation when durable CAS is lost', async () => {
    const redis = new MemoryLeaseRedis()
    const owner = { connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-1', ttlMs: 100 }
    await acquireComfyRequestLease(owner, redis)

    await expect(heartbeatDurableComfyRequestLease(
      owner, { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, redis, new Date(10),
    )).resolves.toEqual({ owned: false, reason: 'db_lost' })
    await expect(acquireComfyRequestLease({
      ...owner, requestId: 'request-2', leaseId: 'lease-2',
    }, redis)).resolves.toBe(true)
  })

  it('does not claim ownership when a slow DB heartbeat outlives Redis TTL and a new owner wins', async () => {
    const redis = new MemoryLeaseRedis()
    const oldOwner = {
      connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-old', ttlMs: 100,
    }
    const newOwner = { ...oldOwner, requestId: 'request-2', leaseId: 'lease-new' }
    const deferred = Promise.withResolvers<{ count: number }>()
    const updateMany = vi.fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue({ count: 1 })
    let clock = new Date(0)
    await acquireComfyRequestLease(oldOwner, redis)

    const heartbeat = heartbeatDurableComfyRequestLease(
      oldOwner, { updateMany }, redis, () => clock,
    )
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalledOnce())
    redis.now = 101
    clock = new Date(101)
    await expect(acquireComfyRequestLease(newOwner, redis)).resolves.toBe(true)
    deferred.resolve({ count: 1 })

    await expect(heartbeat).resolves.toEqual({ owned: false, reason: 'redis_lost' })
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseId: 'lease-old' }),
      data: { leaseExpiresAt: new Date(101) },
    }))
  })

  it('owner-releases Redis without hiding a final durable heartbeat error', async () => {
    const redis = new MemoryLeaseRedis()
    const owner = {
      connectionId: 'connection-1', requestId: 'request-1', leaseId: 'lease-1', ttlMs: 100,
    }
    const databaseError = new Error('final heartbeat failed')
    const updateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(databaseError)
    await acquireComfyRequestLease(owner, redis)

    await expect(heartbeatDurableComfyRequestLease(
      owner, { updateMany }, redis, new Date(10),
    )).rejects.toBe(databaseError)
    await expect(acquireComfyRequestLease({
      ...owner, requestId: 'request-2', leaseId: 'lease-2',
    }, redis)).resolves.toBe(true)
  })
})

function schedulerFixture(overrides: Partial<ComfySchedulerDependencies> = {}) {
  const requests: ComfySchedulableRequest[] = [
    { id: 'request-old', userId: 'user-1', workflowVersionId: 'version-1', status: 'waiting_capacity' as const, queuedAt: new Date('2026-07-11T00:00:00Z'), priority: 0 },
    { id: 'request-new', userId: 'user-1', workflowVersionId: 'version-1', status: 'waiting_capacity' as const, queuedAt: new Date('2026-07-11T00:01:00Z'), priority: 0 },
  ]
  const connections = [
    { id: 'connection-newer', userId: 'user-1', enabled: true, lastAssignedAt: new Date('2026-07-11T00:01:00Z') },
    { id: 'connection-never', userId: 'user-1', enabled: true, lastAssignedAt: null },
    { id: 'connection-older', userId: 'user-1', enabled: true, lastAssignedAt: new Date('2026-07-11T00:00:00Z') },
  ]
  let winner = false
  const deps: ComfySchedulerDependencies = {
    listSchedulableRequests: vi.fn().mockResolvedValue(requests),
    listOwnedEnabledConnections: vi.fn().mockResolvedValue(connections),
    readCachedHealth: vi.fn().mockResolvedValue({ state: 'online_idle' }),
    checkCachedCompatibility: vi.fn().mockResolvedValue(true),
    acquireLease: vi.fn().mockImplementation(async () => {
      if (winner) return false
      winner = true
      return true
    }),
    releaseLease: vi.fn().mockResolvedValue(true),
    makeWaitingIfBlocked: vi.fn().mockResolvedValue(true),
    assignIfEligible: vi.fn().mockResolvedValue('assigned'),
    markBlockedIfEligible: vi.fn().mockResolvedValue(true),
    failIncompatibleIfEligible: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
  return { deps, requests, connections }
}

describe('idle-first ComfyUI scheduler', () => {
  it('immediately excludes a connection disabled by the owner from new assignments', async () => {
    const { deps, connections } = schedulerFixture()
    connections.forEach((connection) => { connection.enabled = false })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'blocked_no_compatible_instance', requestId: 'request-old',
    })
    expect(deps.acquireLease).not.toHaveBeenCalled()
  })

  it('keeps FIFO per user and chooses the least recently assigned compatible idle node', async () => {
    const { deps } = schedulerFixture()
    const result = await scheduleNextComfyRequest('user-1', deps, { leaseTtlMs: 30_000 })

    expect(result).toMatchObject({ outcome: 'leased', requestId: 'request-old', connectionId: 'connection-never' })
    expect(deps.acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-old', connectionId: 'connection-never', ttlMs: 30_000,
    }))
  })

  it('waits without claiming when compatible nodes are busy', async () => {
    const { deps } = schedulerFixture({
      readCachedHealth: vi.fn().mockResolvedValue({ state: 'online_busy_external' }),
    })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'waiting_capacity', requestId: 'request-old',
    })
    expect(deps.acquireLease).not.toHaveBeenCalled()
    expect(deps.markBlockedIfEligible).not.toHaveBeenCalled()
  })

  it('blocks a waiting owner that has no enabled connection', async () => {
    const { deps } = schedulerFixture({
      listOwnedEnabledConnections: vi.fn().mockResolvedValue([]),
    })

    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'blocked_no_compatible_instance', requestId: 'request-old',
    })
    expect(deps.markBlockedIfEligible).toHaveBeenCalledWith('request-old', 'user-1')
    expect(deps.acquireLease).not.toHaveBeenCalled()
  })

  it('fails terminally when every online idle connection is incompatible', async () => {
    const { deps } = schedulerFixture({ checkCachedCompatibility: vi.fn().mockResolvedValue(false) })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'failed_incompatible', requestId: 'request-old',
    })
    expect(deps.failIncompatibleIfEligible).toHaveBeenCalledWith('request-old', 'user-1')
    expect(deps.markBlockedIfEligible).not.toHaveBeenCalled()
  })

  it('reports a lost race when another scheduler changes the request before failing it', async () => {
    const { deps } = schedulerFixture({
      checkCachedCompatibility: vi.fn().mockResolvedValue(false),
      failIncompatibleIfEligible: vi.fn().mockResolvedValue(false),
    })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'lost_race', requestId: 'request-old',
    })
  })

  it('terminalizes a previously blocked request after compatibility becomes known', async () => {
    const { deps, requests } = schedulerFixture({
      checkCachedCompatibility: vi.fn().mockResolvedValue(false),
    })
    requests[0].status = 'blocked_no_compatible_instance'

    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'failed_incompatible', requestId: 'request-old',
    })
    expect(deps.failIncompatibleIfEligible).toHaveBeenCalledWith('request-old', 'user-1')
  })

  it('waits rather than falsely blocking while compatibility is not cached', async () => {
    const { deps } = schedulerFixture({ checkCachedCompatibility: vi.fn().mockResolvedValue(null) })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toEqual({
      outcome: 'waiting_capacity', requestId: 'request-old',
    })
    expect(deps.markBlockedIfEligible).not.toHaveBeenCalled()
  })

  it('moves a formerly blocked request back through waiting before leasing it', async () => {
    const { deps, requests } = schedulerFixture()
    requests[0].status = 'blocked_no_compatible_instance'

    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toMatchObject({ outcome: 'leased' })
    expect(deps.makeWaitingIfBlocked).toHaveBeenCalledWith(
      'request-old', 'user-1', 'blocked_no_compatible_instance',
    )
  })

  it('releases Redis ownership when the database compare-and-set loses', async () => {
    const { deps } = schedulerFixture({
      assignIfEligible: vi.fn().mockResolvedValue('request_lost'),
      releaseLease: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    })
    await expect(scheduleNextComfyRequest('user-1', deps)).resolves.toMatchObject({ outcome: 'lost_race' })
    expect(deps.releaseLease).toHaveBeenCalledOnce()
  })

  it('skips a stale-active LRU node and leases the next idle candidate', async () => {
    const { deps } = schedulerFixture({
      acquireLease: vi.fn().mockResolvedValue(true),
      assignIfEligible: vi.fn()
        .mockResolvedValueOnce('connection_busy')
        .mockResolvedValueOnce('assigned'),
    })

    await expect(scheduleNextComfyRequest('user-1', deps, {
      newLeaseId: vi.fn().mockReturnValueOnce('lease-stale').mockReturnValueOnce('lease-next'),
    })).resolves.toMatchObject({
      outcome: 'leased', requestId: 'request-old', connectionId: 'connection-older',
      leaseId: 'lease-next',
    })
    expect(deps.releaseLease).toHaveBeenCalledWith({
      connectionId: 'connection-never', requestId: 'request-old',
      leaseId: 'lease-stale', ttlMs: 30_000,
    })
  })

  it('best-effort releases Redis ownership when database assignment throws', async () => {
    const databaseError = new Error('transaction failed')
    const { deps } = schedulerFixture({
      assignIfEligible: vi.fn().mockRejectedValue(databaseError),
      releaseLease: vi.fn().mockRejectedValue(new Error('release transport failed')),
    })

    await expect(scheduleNextComfyRequest('user-1', deps, {
      newLeaseId: () => 'lease-crash',
    })).rejects.toBe(databaseError)
    expect(deps.releaseLease).toHaveBeenCalledWith({
      connectionId: 'connection-never', requestId: 'request-old',
      leaseId: 'lease-crash', ttlMs: 30_000,
    })
  })

  it('gives two schedulers racing for one request and node exactly one winner', async () => {
    const { deps } = schedulerFixture()
    const [first, second] = await Promise.all([
      scheduleNextComfyRequest('user-1', deps),
      scheduleNextComfyRequest('user-1', deps),
    ])
    expect([first.outcome, second.outcome].sort()).toEqual(['leased', 'lost_race'])
    expect(deps.assignIfEligible).toHaveBeenCalledOnce()
  })

  it('gives two schedulers one winner through the real memory Redis and DB CAS gates', async () => {
    const redis = new MemoryLeaseRedis()
    let requestAvailable = true
    const { deps } = schedulerFixture({
      acquireLease: (owner) => acquireComfyRequestLease(owner, redis),
      releaseLease: (owner) => releaseComfyRequestLease(owner, redis),
      assignIfEligible: (input) => assignComfyRequestWithStore(input, transactionStore(
        vi.fn().mockResolvedValue({ count: 1 }),
        vi.fn().mockImplementation(async () => {
          if (!requestAvailable) return { count: 0 }
          requestAvailable = false
          return { count: 1 }
        }),
      )),
    })

    const results = await Promise.all([
      scheduleNextComfyRequest('user-1', deps),
      scheduleNextComfyRequest('user-1', deps),
    ])
    expect(results.filter((result) => result.outcome === 'leased')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'lost_race')).toHaveLength(1)
  })
})

describe('ComfyUI database assignment CAS', () => {
  const input = {
    requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
    leaseId: 'lease-1', leaseExpiresAt: new Date('2026-07-11T00:01:00Z'),
    assignedAt: new Date('2026-07-11T00:00:00Z'),
  }

  it('revalidates enabled ownership before assigning the request', async () => {
    const updateRequest = vi.fn()
    const updateConnection = vi.fn().mockResolvedValue({ count: 0 })
    const store = transactionStore(updateConnection, updateRequest)

    await expect(assignComfyRequestWithStore(input, store)).resolves.toBe('connection_busy')
    expect(updateConnection).toHaveBeenCalledWith({
      where: { id: 'connection-1', userId: 'user-1', enabled: true },
      data: { lastAssignedAt: input.assignedAt },
    })
    expect(updateRequest).not.toHaveBeenCalled()
  })

  it('fails closed while the connection still has another nonterminal request', async () => {
    const updateRequest = vi.fn().mockResolvedValue({ count: 1 })
    const updateConnection = vi.fn().mockResolvedValue({ count: 1 })
    const countActiveRequests = vi.fn().mockResolvedValue(1)
    const store = transactionStore(updateConnection, updateRequest, countActiveRequests)

    await expect(assignComfyRequestWithStore(input, store)).resolves.toBe('connection_busy')
    expect(countActiveRequests).toHaveBeenCalledWith({
      where: {
        connectionId: 'connection-1',
        id: { not: 'request-1' },
        status: { in: [
          'leased', 'uploading', 'submitting', 'submitted', 'running', 'transferring', 'reconciling',
        ] },
        task: { status: { in: ['queued', 'processing'] } },
      },
    })
    expect(updateConnection).not.toHaveBeenCalled()
    expect(updateRequest).not.toHaveBeenCalled()
  })

  it('claims the request with eligibility CAS in the same transaction', async () => {
    const updateRequest = vi.fn().mockResolvedValue({ count: 1 })
    const updateConnection = vi.fn().mockResolvedValue({ count: 1 })
    const store = transactionStore(updateConnection, updateRequest)

    await expect(assignComfyRequestWithStore(input, store)).resolves.toBe('assigned')
    expect(updateRequest).toHaveBeenCalledWith({
      where: {
        id: 'request-1', userId: 'user-1',
        status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] },
        connectionId: null, leaseId: null,
        task: { status: { in: ['queued', 'processing'] } },
      },
      data: {
        status: 'leased', connectionId: 'connection-1', leaseId: 'lease-1',
        leaseExpiresAt: input.leaseExpiresAt, leasedAt: input.assignedAt,
      },
    })
  })

  it('distinguishes a lost request CAS from a busy connection', async () => {
    const updateRequest = vi.fn().mockResolvedValue({ count: 0 })
    const updateConnection = vi.fn().mockResolvedValue({ count: 1 })

    await expect(assignComfyRequestWithStore(
      input, transactionStore(updateConnection, updateRequest),
    )).resolves.toBe('request_lost')
  })
})

function transactionStore(
  updateConnection: ReturnType<typeof vi.fn>,
  updateRequest: ReturnType<typeof vi.fn>,
  countActiveRequests: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(0),
) {
  return {
    transaction: async <T>(operation: (client: {
      updateConnection: typeof updateConnection
      updateRequest: typeof updateRequest
      countActiveRequests: typeof countActiveRequests
    }) => Promise<T>) => operation({ updateConnection, updateRequest, countActiveRequests }),
  }
}
