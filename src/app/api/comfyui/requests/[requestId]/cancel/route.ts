import type { ComfyConnection, ComfyGenerationRequest } from '@prisma/client'
import { NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ComfyClient } from '@/lib/comfyui/client'
import {
  cancelComfyRequest,
  type ComfyCancellationDependencies,
} from '@/lib/comfyui/dispatcher'
import { comfyRequestLeaseValue, releaseComfyRequestLease } from '@/lib/comfyui/lease'
import type { ComfyNetworkPolicyConfig } from '@/lib/comfyui/network-policy'
import { comfyLeaseKey } from '@/lib/comfyui/test-lease'
import type { ComfyConnectionAuth, ComfyRequestStatus } from '@/lib/comfyui/types'
import { decryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'

type Context = { params: Promise<{ requestId: string }> }

export const POST = apiHandler(async (_request, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { requestId } = await context.params
  const result = await cancelComfyRequest(
    requestId,
    auth.session.user.id,
    createCancellationDependencies(),
  )
  return NextResponse.json(result)
})

function createCancellationDependencies(): ComfyCancellationDependencies {
  let loaded: (ComfyGenerationRequest & { connection: ComfyConnection | null }) | null = null
  let client: ComfyClient | null = null
  const requireClient = () => {
    if (!client) throw new ApiError('CONFLICT')
    return client
  }
  return {
    loadOwnedRequest: async (requestId, userId) => {
      loaded = await prisma.comfyGenerationRequest.findFirst({
        where: { id: requestId, userId }, include: { connection: true },
      })
      if (!loaded) return null
      if (loaded.connection) {
        client = new ComfyClient({
          baseUrl: loaded.connection.normalizedBaseUrl,
          auth: decodeAuth(loaded.connection),
          networkPolicy: networkPolicy(),
        })
      }
      return {
        id: loaded.id,
        taskId: loaded.taskId,
        userId: loaded.userId,
        projectId: loaded.projectId,
        workflowId: loaded.workflowId,
        workflowVersionId: loaded.workflowVersionId,
        status: loaded.status as ComfyRequestStatus,
        connectionId: loaded.connectionId,
        leaseId: loaded.leaseId,
        promptId: loaded.promptId,
        clientId: loaded.clientId,
      }
    },
    cancelLocal: async ({ requestId, userId, status }) => {
      const result = await prisma.comfyGenerationRequest.updateMany({
        where: { id: requestId, userId, status, connectionId: null, leaseId: null },
        data: { status: 'canceled', canceledAt: new Date() },
      })
      return result.count === 1
    },
    verifyLeaseOwner: async (owner) => {
      if (!loaded || loaded.id !== owner.requestId || loaded.userId !== owner.userId
        || loaded.connectionId !== owner.connectionId || loaded.leaseId !== owner.leaseId) return false
      const [leaseValue, count] = await Promise.all([
        redis.get(comfyLeaseKey(owner.connectionId)),
        prisma.comfyGenerationRequest.count({
          where: {
            id: owner.requestId, userId: owner.userId, connectionId: owner.connectionId,
            leaseId: owner.leaseId, status: { notIn: ['completed', 'failed', 'canceled'] },
          },
        }),
      ])
      return count === 1 && leaseValue === comfyRequestLeaseValue(owner)
    },
    requestCancellation: async (input) => prisma.$transaction(async (tx) => {
      if (input.observedStatus === 'leased' || input.observedStatus === 'uploading') {
        const local = await tx.comfyGenerationRequest.updateMany({
          where: {
            id: input.requestId, userId: input.userId, connectionId: input.connectionId,
            leaseId: input.leaseId, status: input.observedStatus,
            promptId: null, cancelRequestedAt: null,
          },
          data: { status: 'canceled', cancelRequestedAt: new Date(), canceledAt: new Date() },
        })
        if (local.count === 1) return 'canceled' as const
      }
      const requested = await tx.comfyGenerationRequest.updateMany({
        where: {
          id: input.requestId, userId: input.userId, connectionId: input.connectionId,
          leaseId: input.leaseId,
          status: { in: ['submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
          ...(input.promptId ? { promptId: input.promptId } : {}),
        },
        data: { cancelRequestedAt: new Date() },
      })
      if (requested.count === 1) return 'requested' as const
      const current = await tx.comfyGenerationRequest.findFirst({
        where: { id: input.requestId, userId: input.userId }, select: { status: true },
      })
      return current?.status === 'canceled' ? 'canceled' as const : 'lost' as const
    }, { isolationLevel: 'Serializable' }),
    getQueue: () => requireClient().getQueue(),
    getHistory: (promptId) => requireClient().getHistory(promptId),
    deleteQueuedPrompt: (promptId) => requireClient().deleteQueuedPrompt(promptId),
    markCanceledOwned: async (input) => {
      const result = await prisma.comfyGenerationRequest.updateMany({
        where: {
          id: input.requestId, userId: input.userId, connectionId: input.connectionId,
          leaseId: input.leaseId,
          ...(input.promptId ? { promptId: input.promptId } : { promptId: null }),
          cancelRequestedAt: { not: null },
          status: { notIn: ['completed', 'failed', 'canceled'] },
        },
        data: { status: 'canceled', canceledAt: new Date() },
      })
      return result.count === 1
    },
    release: (owner) => releaseComfyRequestLease({ ...owner, ttlMs: 1 }),
  }
}

function decodeAuth(connection: ComfyConnection): ComfyConnectionAuth {
  if (connection.authType === 'none') return { type: 'none' }
  if (!connection.authSecretEncrypted) throw new ApiError('MISSING_CONFIG')
  let value: unknown
  try { value = JSON.parse(decryptApiKey(connection.authSecretEncrypted)) } catch {
    throw new ApiError('MISSING_CONFIG')
  }
  if (connection.authType === 'bearer' && isRecord(value) && typeof value.token === 'string') {
    return { type: 'bearer', token: value.token }
  }
  if (connection.authType === 'basic' && isRecord(value)
    && typeof value.username === 'string' && typeof value.password === 'string') {
    return { type: 'basic', username: value.username, password: value.password }
  }
  throw new ApiError('MISSING_CONFIG')
}

function networkPolicy(): ComfyNetworkPolicyConfig {
  return {
    mode: process.env.COMFYUI_NETWORK_MODE === 'trusted' ? 'trusted' : 'allowlist',
    allowedHosts: list(process.env.COMFYUI_ALLOWED_HOSTS),
    allowedCidrs: list(process.env.COMFYUI_ALLOWED_CIDRS),
  }
}

function list(value: string | undefined) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
