import { Prisma, type ComfyConnection } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { decryptApiKey, encryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'

import { ComfyClient } from './client'
import { deriveComfyHealth, sanitizeComfyHealthDiagnostic } from './health'
import { authorizeComfyTarget, type ComfyNetworkPolicyConfig } from './network-policy'
import type { ComfyAuthType, ComfyConnectionAuth, ComfyHealthSummary } from './types'

const TERMINAL_REQUEST_STATUSES = ['completed', 'failed', 'canceled'] as const

export type ComfyCredentialInput =
  | { token: string }
  | { username: string; password: string }

export interface CreateComfyConnectionInput {
  name: string
  baseUrl: string
  authType: ComfyAuthType
  credentials?: ComfyCredentialInput
  enabled?: boolean
}

export interface UpdateComfyConnectionInput {
  name?: string
  baseUrl?: string
  authType?: ComfyAuthType
  credentials?: ComfyCredentialInput
  enabled?: boolean
}

export function normalizeComfyBaseUrl(rawValue: string): string {
  const trimmed = rawValue.trim()
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new ApiError('INVALID_PARAMS')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash) {
    throw new ApiError('INVALID_PARAMS')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

export async function listOwnedConnections(userId: string) {
  const records = await prisma.comfyConnection.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  return records.map(toPublicConnection)
}

export async function createOwnedConnection(userId: string, input: CreateComfyConnectionInput) {
  const normalizedBaseUrl = normalizeComfyBaseUrl(input.baseUrl)
  const authSecretEncrypted = encodeCredentials(input.authType, input.credentials)
  try {
    const record = await prisma.comfyConnection.create({
      data: {
        userId,
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim(),
        normalizedBaseUrl,
        authType: input.authType,
        authSecretEncrypted,
        enabled: input.enabled ?? true,
      },
    })
    return toPublicConnection(record)
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError('CONFLICT')
    throw error
  }
}

export async function getOwnedConnection(userId: string, connectionId: string) {
  const record = await findOwnedConnection(userId, connectionId)
  return toPublicConnection(record)
}

export async function updateOwnedConnection(
  userId: string,
  connectionId: string,
  input: UpdateComfyConnectionInput,
) {
  const existing = await findOwnedConnection(userId, connectionId)
  const nextAuthType = input.authType ?? (existing.authType as ComfyAuthType)
  const data: Record<string, unknown> = {}
  if (input.name !== undefined) data.name = input.name.trim()
  if (input.baseUrl !== undefined) {
    data.baseUrl = input.baseUrl.trim()
    data.normalizedBaseUrl = normalizeComfyBaseUrl(input.baseUrl)
  }
  if (input.enabled !== undefined) data.enabled = input.enabled
  if (input.authType !== undefined) data.authType = input.authType
  if (nextAuthType === 'none') {
    data.authSecretEncrypted = null
  } else if (input.credentials !== undefined) {
    data.authSecretEncrypted = encodeCredentials(nextAuthType, input.credentials)
  } else if (input.authType !== undefined && input.authType !== existing.authType) {
    throw new ApiError('INVALID_PARAMS')
  }

  try {
    const record = await prisma.comfyConnection.update({
      where: { id_userId: { id: existing.id, userId } },
      data,
    })
    return toPublicConnection(record)
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError('CONFLICT')
    throw error
  }
}

export async function deleteOwnedConnection(userId: string, connectionId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.comfyConnection.findFirst({ where: { id: connectionId, userId } })
    if (!existing) throw new ApiError('NOT_FOUND')
    const activeCount = await tx.comfyGenerationRequest.count({
      where: {
        connectionId: existing.id,
        userId,
        status: { notIn: [...TERMINAL_REQUEST_STATUSES] },
      },
    })
    if (activeCount > 0) throw new ApiError('CONFLICT')
    await tx.comfyGenerationRequest.updateMany({
      where: {
        connectionId: existing.id,
        userId,
        status: { in: [...TERMINAL_REQUEST_STATUSES] },
      },
      data: { connectionId: null, leaseId: null, leaseExpiresAt: null },
    })
    await tx.comfyConnection.delete({
      where: { id_userId: { id: existing.id, userId } },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export async function probeOwnedConnection(
  userId: string,
  connectionId: string,
): Promise<ComfyHealthSummary> {
  const record = await findOwnedConnection(userId, connectionId)
  return probeAuthorizedConnection(record, userId)
}

export async function probeOwnedConnectionStatuses(userId: string) {
  const records = await prisma.comfyConnection.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: 'asc' },
  })
  return Promise.all(records.map(async (record) => ({
    connectionId: record.id,
    ...await probeAuthorizedConnection(record, userId),
  })))
}

async function probeAuthorizedConnection(record: ComfyConnection, userId: string) {
  const policy = readNetworkPolicy()
  const checkedAt = new Date()
  let summary: ComfyHealthSummary
  try {
    await authorizeComfyTarget(record.normalizedBaseUrl, policy)
    const client = new ComfyClient({
      baseUrl: record.normalizedBaseUrl,
      auth: decodeCredentials(record),
      networkPolicy: policy,
    })
    const [systemStats, queue, ownedNonterminalCount] = await Promise.all([
      client.getSystemStats(),
      client.getQueue(),
      countOwnedNonterminal(record.id, userId),
    ])
    summary = deriveComfyHealth({ checkedAt, systemStats, queue, ownedNonterminalCount })
  } catch (error) {
    summary = deriveComfyHealth({ checkedAt, error, ownedNonterminalCount: 0 })
  }
  await prisma.comfyConnection.update({
    where: { id_userId: { id: record.id, userId } },
    data: sanitizeComfyHealthDiagnostic(summary),
  })
  return summary
}

async function countOwnedNonterminal(connectionId: string, userId: string) {
  return prisma.comfyGenerationRequest.count({
    where: {
      connectionId,
      userId,
      status: { notIn: [...TERMINAL_REQUEST_STATUSES] },
    },
  })
}

async function findOwnedConnection(userId: string, connectionId: string): Promise<ComfyConnection> {
  const record = await prisma.comfyConnection.findFirst({ where: { id: connectionId, userId } })
  if (!record) throw new ApiError('NOT_FOUND')
  return record
}

function encodeCredentials(authType: ComfyAuthType, credentials: ComfyCredentialInput | undefined) {
  if (authType === 'none') return null
  if (!credentials || !credentialsMatchAuthType(authType, credentials)) {
    throw new ApiError('INVALID_PARAMS')
  }
  return encryptApiKey(JSON.stringify(credentials))
}

function decodeCredentials(record: ComfyConnection): ComfyConnectionAuth {
  if (record.authType === 'none') return { type: 'none' }
  if (!record.authSecretEncrypted) throw new ApiError('MISSING_CONFIG')
  let value: unknown
  try {
    value = JSON.parse(decryptApiKey(record.authSecretEncrypted))
  } catch {
    throw new ApiError('MISSING_CONFIG')
  }
  if (record.authType === 'bearer' && isBearerCredentials(value)) {
    return { type: 'bearer', token: value.token }
  }
  if (record.authType === 'basic' && isBasicCredentials(value)) {
    return { type: 'basic', username: value.username, password: value.password }
  }
  throw new ApiError('MISSING_CONFIG')
}

function credentialsMatchAuthType(type: ComfyAuthType, value: ComfyCredentialInput) {
  return type === 'bearer' ? isBearerCredentials(value) : isBasicCredentials(value)
}

function isBearerCredentials(value: unknown): value is { token: string } {
  return !!value && typeof value === 'object' && 'token' in value
    && typeof value.token === 'string' && value.token.trim().length > 0
}

function isBasicCredentials(value: unknown): value is { username: string; password: string } {
  return !!value && typeof value === 'object' && 'username' in value && 'password' in value
    && typeof value.username === 'string' && value.username.trim().length > 0
    && typeof value.password === 'string' && value.password.length > 0
}

function readNetworkPolicy(): ComfyNetworkPolicyConfig {
  return {
    mode: process.env.COMFYUI_NETWORK_MODE === 'trusted' ? 'trusted' : 'allowlist',
    allowedHosts: commaList(process.env.COMFYUI_ALLOWED_HOSTS),
    allowedCidrs: commaList(process.env.COMFYUI_ALLOWED_CIDRS),
  }
}

function commaList(value: string | undefined) {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function toPublicConnection(record: ComfyConnection) {
  return {
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    normalizedBaseUrl: record.normalizedBaseUrl,
    authType: record.authType,
    enabled: record.enabled,
    hasCredentials: !!record.authSecretEncrypted,
    lastHealthAt: record.lastHealthAt?.toISOString() ?? null,
    lastHealthCode: record.lastHealthCode,
    lastHealthMessage: record.lastHealthMessage,
    lastSeenVersion: record.lastSeenVersion,
    deviceSummary: record.deviceSummary,
    lastAssignedAt: record.lastAssignedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueViolation(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002'
}
