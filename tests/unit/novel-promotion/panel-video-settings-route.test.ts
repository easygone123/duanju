import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const findFirstMock = vi.hoisted(() => vi.fn())
const updateManyMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn(() => false),
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    novelPromotionPanel: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
    },
  },
}))

import { PATCH } from '@/app/api/novel-promotion/[projectId]/panel/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/novel-promotion/project-1/panel', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('panel video settings PATCH', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findFirstMock.mockResolvedValue({ id: 'panel-1', updatedAt: new Date('2026-07-13T02:00:00.000Z') })
    updateManyMock.mockResolvedValue({ count: 1 })
  })

  it('saves duration override and dialogue inclusion separately without submitting generation', async () => {
    const response = await PATCH(request({
      panelId: 'panel-1', durationOverride: 8, includeDialogueInVideoPrompt: false,
      expectedPanelUpdatedAt: '2026-07-13T02:00:00.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'panel-1', updatedAt: new Date('2026-07-13T02:00:00.000Z') },
      data: { durationOverride: 8, includeDialogueInVideoPrompt: false },
    })
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('clears duration override with null and returns the updated version', async () => {
    const response = await PATCH(request({
      panelId: 'panel-1', durationOverride: null,
      expectedPanelUpdatedAt: '2026-07-13T02:00:00.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: { durationOverride: null } }))
  })
})
