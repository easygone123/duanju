import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../helpers/prisma'
import { buildMockRequest } from '../../../helpers/request'

const authState = vi.hoisted(() => ({ userId: '' }))
const probeVideoMock = vi.hoisted(() => vi.fn())
const uploadObjectStreamMock = vi.hoisted(() => vi.fn())
const deleteObjectMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireUserAuth: async () => ({ session: { user: { id: authState.userId } } }),
}))
vi.mock('@/lib/viral-replication/ffmpeg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/viral-replication/ffmpeg')>()), probeVideo: probeVideoMock,
}))
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  uploadObjectStream: uploadObjectStreamMock, deleteObject: deleteObjectMock,
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))

describe('viral replication ownership and brief lifecycle', () => {
  let ownerId: string
  let otherId: string
  let replicationId: string

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8)
    const owner = await prisma.user.create({ data: { name: `viral_owner_${suffix}` } })
    const other = await prisma.user.create({ data: { name: `viral_other_${suffix}` } })
    ownerId = owner.id
    otherId = other.id
    authState.userId = ownerId
    const replication = await prisma.viralReplication.create({
      data: { userId: ownerId, brief: '初始方向', videoRatio: '9:16', artStyle: 'realistic', status: 'uploading' },
    })
    replicationId = replication.id
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await prisma.viralReplication.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    await prisma.project.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    await prisma.userPreference.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
  })

  it('returns NOT_FOUND for a non-owner GET', async () => {
    authState.userId = otherId
    const { GET } = await import('@/app/api/viral-replications/[id]/route')
    const response = await GET(buildMockRequest({
      path: `/api/viral-replications/${replicationId}`, method: 'GET',
    }), { params: Promise.resolve({ id: replicationId }) })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('returns NOT_FOUND for a non-owner PATCH without changing the brief', async () => {
    authState.userId = otherId
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const response = await PATCH(buildMockRequest({
      path: `/api/viral-replications/${replicationId}`, method: 'PATCH', body: { brief: '越权修改' },
    }), { params: Promise.resolve({ id: replicationId }) })
    expect(response.status).toBe(404)
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({ brief: '初始方向' })
  })

  it('returns NOT_FOUND for a non-owner PUT before media processing', async () => {
    authState.userId = otherId
    const { PUT } = await import('@/app/api/viral-replications/[id]/video/route')
    const response = await PUT(new NextRequest(`http://localhost/api/viral-replications/${replicationId}/video`, {
      method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: Buffer.from('video'),
    }), { params: Promise.resolve({ id: replicationId }) })
    expect(response.status).toBe(404)
    expect(probeVideoMock).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
  })

  it.each(['uploading', 'review_ready', 'failed'])('allows brief updates while status=%s', async (status) => {
    await prisma.viralReplication.update({ where: { id: replicationId }, data: { status } })
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const response = await PATCH(buildMockRequest({
      path: `/api/viral-replications/${replicationId}`, method: 'PATCH', body: { brief: `允许-${status}` },
    }), { params: Promise.resolve({ id: replicationId }) })
    expect(response.status).toBe(200)
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({ brief: `允许-${status}` })
  })

  it.each(['analyzing', 'generating', 'completed'])('rejects brief updates while status=%s', async (status) => {
    await prisma.viralReplication.update({ where: { id: replicationId }, data: { status } })
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const response = await PATCH(buildMockRequest({
      path: `/api/viral-replications/${replicationId}`, method: 'PATCH', body: { brief: '不应修改' },
    }), { params: Promise.resolve({ id: replicationId }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { details: { code: 'VIRAL_REPLICATION_BRIEF_LOCKED' } } })
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({ brief: '初始方向' })
  })
})
