import { Prisma, type ComfyConnection } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { decryptApiKey, encryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'

import { ComfyClient, type ComfyClientOptions } from './client'
import { deriveComfyHealth, sanitizeComfyHealthDiagnostic } from './health'
import { authorizeComfyTarget, type ComfyNetworkPolicyConfig } from './network-policy'
import type { ComfyAuthType, ComfyConnectionAuth, ComfyDeviceSummary, ComfyHealthSummary } from './types'
import { acquireComfyLease, releaseComfyLease, startComfyLeaseGuard } from './test-lease'

const TERMINAL_REQUEST_STATUSES = ['completed', 'failed', 'canceled'] as const
const MAX_DELETE_ATTEMPTS = 3
const MAX_STABLE_PROBE_ATTEMPTS = 3
const DEFAULT_STATUS_PROBE_CONCURRENCY = 4
const MAX_STATUS_PROBE_CONCURRENCY = 8
const DELETE_LEASE_TTL_MS = 30_000

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

export interface ComfyProbeOptions {
  networkPolicy: ComfyNetworkPolicyConfig
  clientLimits: Pick<
    ComfyClientOptions,
    'timeoutMs' | 'maxWorkflowBytes' | 'maxInputBytes' | 'maxOutputBytes'
  >
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
  const initial = await findOwnedConnection(userId, connectionId)
  if (!isConnectionIdentityMutation(input)) {
    return updateOwnedConnectionRecord(userId, initial, input)
  }
  const leaseValue = JSON.stringify({ type: 'connection-update', id: randomUUID(), userId })
  const leaseKey = await acquireComfyLease(connectionId, leaseValue, DELETE_LEASE_TTL_MS)
  const guard = startComfyLeaseGuard({
    key: leaseKey, value: leaseValue, ttlMs: DELETE_LEASE_TTL_MS, timeoutMs: DELETE_LEASE_TTL_MS,
  })
  try {
    await guard.assertOwned()
    const existing = await findOwnedConnection(userId, connectionId)
    if (await countOwnedNonterminal(connectionId, userId) > 0) {
      throw new ApiError('CONFLICT')
    }
    const result = await updateOwnedConnectionRecord(userId, existing, input)
    await guard.assertOwned()
    return result
  } finally {
    await guard.stop()
    await releaseComfyLease(leaseKey, leaseValue).catch(() => undefined)
  }
}

async function updateOwnedConnectionRecord(
  userId: string,
  existing: ComfyConnection,
  input: UpdateComfyConnectionInput,
) {
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

function isConnectionIdentityMutation(input: UpdateComfyConnectionInput) {
  return input.baseUrl !== undefined || input.authType !== undefined || input.credentials !== undefined
}

export async function deleteOwnedConnection(userId: string, connectionId: string) {
  await findOwnedConnection(userId, connectionId)
  // The shared Redis lease serializes delete with live tests and generation claims.
  const leaseValue = JSON.stringify({ type: 'delete', id: randomUUID(), userId })
  const leaseKey = await acquireComfyLease(connectionId, leaseValue, DELETE_LEASE_TTL_MS)
  try {
    for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt += 1) {
      try {
        await deleteOwnedConnectionOnce(userId, connectionId)
        return
      } catch (error) {
        if (isPrismaCode(error, 'P2034') && attempt < MAX_DELETE_ATTEMPTS) continue
        if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2003')) {
          throw new ApiError('CONFLICT')
        }
        throw error
      }
    }
  } finally {
    await releaseComfyLease(leaseKey, leaseValue).catch(() => undefined)
  }
}

export async function probeOwnedConnection(
  userId: string,
  connectionId: string,
): Promise<ComfyHealthSummary> {
  const record = await findOwnedConnection(userId, connectionId)
  const summary = await probeStableConnection(record, userId, false)
  if (!summary) throw new ApiError('CONFLICT')
  return summary
}

export async function probeOwnedConnectionStatuses(
  userId: string,
  options?: ComfyProbeOptions,
) {
  const records = await prisma.comfyConnection.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  const statuses = await mapWithConcurrency(
    records,
    readStatusProbeConcurrency(),
    async (record) => {
      try {
        const ownedTask = await findOwnedActiveRequest(record.id, userId)
        if (!record.enabled) return disabledConnectionStatus(record, ownedTask)
        const summary = await probeStableConnection(record, userId, true, options)
        if (!summary) return null
        return {
          connectionId: record.id,
          ...summary,
          ownedTask,
        }
      } catch (error) {
        if (error instanceof ApiError
          && (error.code === 'NOT_FOUND' || error.code === 'CONFLICT')) return null
        throw error
      }
    },
  )
  return statuses.filter((status) => status !== null)
}

function disabledConnectionStatus(
  record: ComfyConnection,
  ownedTask: { requestId: string; taskId: string; status: string } | null,
) {
  const devices = readStoredDevices(record.deviceSummary)
  return {
    connectionId: record.id,
    state: 'disabled' as const,
    checkedAt: record.lastHealthAt?.toISOString() ?? null,
    ...(record.lastSeenVersion ? { version: record.lastSeenVersion.slice(0, 100) } : {}),
    ...(devices.length > 0 ? { devices } : {}),
    ...(record.lastHealthMessage ? { message: record.lastHealthMessage.slice(0, 200) } : {}),
    runningCount: 0,
    pendingCount: 0,
    ownedTask,
  }
}

function readStoredDevices(value: Prisma.JsonValue): ComfyDeviceSummary[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 16).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const name = typeof entry.name === 'string' ? entry.name.slice(0, 160) : undefined
    const type = typeof entry.type === 'string' ? entry.type.slice(0, 80) : undefined
    const vramTotalBytes = storedNonnegativeNumber(entry.vramTotalBytes)
    const vramFreeBytes = storedNonnegativeNumber(entry.vramFreeBytes)
    return [{
      ...(name ? { name } : {}), ...(type ? { type } : {}),
      ...(vramTotalBytes !== undefined ? { vramTotalBytes } : {}),
      ...(vramFreeBytes !== undefined ? { vramFreeBytes } : {}),
    }]
  })
}

function storedNonnegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function probeStableConnection(
  initialRecord: ComfyConnection,
  userId: string,
  discardWhenDisabled: boolean,
  options?: ComfyProbeOptions,
): Promise<ComfyHealthSummary | null> {
  let record = initialRecord
  for (let attempt = 1; attempt <= MAX_STABLE_PROBE_ATTEMPTS; attempt += 1) {
    const summary = await collectProbe(record, userId, options)
    const persisted = await prisma.comfyConnection.updateMany({
      where: {
        id: record.id,
        userId,
        normalizedBaseUrl: record.normalizedBaseUrl,
        authType: record.authType,
        authSecretEncrypted: record.authSecretEncrypted,
        enabled: record.enabled,
      },
      data: sanitizeComfyHealthDiagnostic(summary),
    })
    if (persisted.count === 1) return summary
    const current = await prisma.comfyConnection.findFirst({
      where: { id: record.id, userId },
    })
    if (!current) throw new ApiError('NOT_FOUND')
    if (discardWhenDisabled && !current.enabled) return null
    record = current
  }
  throw new ApiError('CONFLICT')
}

async function collectProbe(
  record: ComfyConnection,
  userId: string,
  options?: ComfyProbeOptions,
) {
  const policy = options?.networkPolicy ?? readNetworkPolicy()
  const checkedAt = new Date()
  let summary: ComfyHealthSummary
  try {
    await authorizeComfyTarget(record.normalizedBaseUrl, policy)
    const client = new ComfyClient({
      baseUrl: record.normalizedBaseUrl,
      auth: decodeCredentials(record),
      networkPolicy: policy,
      ...(options?.clientLimits ?? {}),
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
  return summary
}

async function deleteOwnedConnectionOnce(userId: string, connectionId: string) {
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

async function countOwnedNonterminal(connectionId: string, userId: string) {
  return prisma.comfyGenerationRequest.count({
    where: {
      connectionId,
      userId,
      status: { notIn: [...TERMINAL_REQUEST_STATUSES] },
    },
  })
}

async function findOwnedActiveRequest(connectionId: string, userId: string) {
  const request = await prisma.comfyGenerationRequest.findFirst({
    where: {
      connectionId,
      userId,
      status: { notIn: [...TERMINAL_REQUEST_STATUSES] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, taskId: true, status: true },
  })
  return request ? { requestId: request.id, taskId: request.taskId, status: request.status } : null
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

export function createOwnedComfyClient(connection: ComfyConnection) {
  return new ComfyClient({
    baseUrl: connection.normalizedBaseUrl,
    auth: decodeCredentials(connection),
    networkPolicy: readNetworkPolicy(),
  })
}

function commaList(value: string | undefined) {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function readStatusProbeConcurrency() {
  const configured = Number(process.env.COMFYUI_STATUS_PROBE_CONCURRENCY)
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_STATUS_PROBE_CONCURRENCY
  return Math.min(configured, MAX_STATUS_PROBE_CONCURRENCY)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
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
  return isPrismaCode(error, 'P2002')
}

function isPrismaCode(error: unknown, code: string) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}
