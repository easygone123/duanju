import { randomUUID } from 'node:crypto'
import type { ComfyConnection, ComfyWorkflowVersion } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { decryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'

import { ComfyClient } from './client'
import { COMFY_ERROR_CODE, ComfyError } from './errors'
import { authorizeComfyTarget, type ComfyNetworkPolicyConfig } from './network-policy'
import { acquireComfyLease, releaseComfyLease, startComfyLeaseGuard } from './test-lease'
import type {
  ComfyApiWorkflow,
  ComfyConnectionAuth,
  ComfyInputBinding,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyVariableValue,
  ComfyWorkflowRequirements,
} from './types'
import { extractComfyOutputs } from './workflow-output'
import { renderComfyWorkflow } from './workflow-renderer'
import { validateWorkflowContract } from './workflow-schema'

const TEST_LEASE_TTL_MS = 5 * 60 * 1000
const TEST_RUN_TIMEOUT_MS = 5 * 60 * 1000

export interface LiveTestUploadPayload {
  filename: string
  contentType: string
  base64: string
}

export interface LiveTestInput {
  versionId: string
  connectionId: string
  variables: Record<string, ComfyVariableValue | undefined>
  uploads?: Record<string, LiveTestUploadPayload | LiveTestUploadPayload[]>
}

export async function recordSuccessfulWorkflowTest(
  userId: string,
  versionId: string,
  connectionId: string,
) {
  await markSuccessfulWorkflowTest(userId, versionId, connectionId)
}

async function markSuccessfulWorkflowTest(
  userId: string,
  versionId: string,
  connectionId: string,
) {
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: { id: versionId, workflow: { userId } },
    select: {
      id: true, workflowId: true, lastSuccessfulTestAt: true, lastTestConnectionId: true,
    },
  })
  if (!version) throw new ApiError('NOT_FOUND')
  const connection = await prisma.comfyConnection.findFirst({
    where: { id: connectionId, userId }, select: { id: true },
  })
  if (!connection) throw new ApiError('NOT_FOUND')
  const testedAt = new Date()
  const result = await prisma.comfyWorkflowVersion.updateMany({
    where: { id: versionId, workflowId: version.workflowId },
    data: { lastSuccessfulTestAt: testedAt, lastTestConnectionId: connectionId },
  })
  if (result.count !== 1) throw new ApiError('CONFLICT')
  return {
    versionId, workflowId: version.workflowId, connectionId, testedAt,
    previousTestedAt: version.lastSuccessfulTestAt,
    previousConnectionId: version.lastTestConnectionId,
  }
}

export async function runOwnedWorkflowTest(
  userId: string,
  workflowId: string,
  input: LiveTestInput,
) {
  try {
    return await runOwnedWorkflowTestInternal(userId, workflowId, input)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (isComfyErrorLike(error)) throw mapComfyError(error)
    throw new ApiError('INTERNAL_ERROR')
  }
}

async function runOwnedWorkflowTestInternal(
  userId: string,
  workflowId: string,
  input: LiveTestInput,
) {
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: { id: workflowId, userId, status: { not: 'archived' } },
  })
  if (!workflow) throw new ApiError('NOT_FOUND')
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: { id: input.versionId, workflowId },
  })
  if (!version) throw new ApiError('NOT_FOUND')
  const issues = validationForVersion(version)
  if (issues.length > 0) throw new ApiError('INVALID_PARAMS', { validationIssues: issues })
  const connection = await prisma.comfyConnection.findFirst({
    where: { id: input.connectionId, userId, enabled: true },
  })
  if (!connection) throw new ApiError('NOT_FOUND')

  const networkPolicy = readNetworkPolicy()
  await authorizeComfyTarget(connection.normalizedBaseUrl, networkPolicy)
  const client = new ComfyClient({
    baseUrl: connection.normalizedBaseUrl, auth: connectionAuth(connection), networkPolicy,
  })
  const queue = await client.getQueue()
  if (queue.running.length > 0 || queue.pending.length > 0) throw new ApiError('CONFLICT')
  await assertCompatible(client, version)

  const leaseValue = JSON.stringify({ type: 'test-run', id: randomUUID(), userId, workflowId })
  const leaseKey = await acquireComfyLease(connection.id, leaseValue, TEST_LEASE_TTL_MS)
  const guard = startComfyLeaseGuard({
    key: leaseKey, value: leaseValue, ttlMs: TEST_LEASE_TTL_MS, timeoutMs: TEST_RUN_TIMEOUT_MS,
  })
  try {
    await guard.assertOwned()
    const claimedConnection = await prisma.comfyConnection.findFirst({
      where: { id: connection.id, userId },
    })
    if (!claimedConnection || !sameConnectionExecutionIdentity(connection, claimedConnection)) {
      throw new ApiError('CONFLICT')
    }
    const claimedQueue = await client.getQueue()
    if (claimedQueue.running.length > 0 || claimedQueue.pending.length > 0) {
      throw new ApiError('CONFLICT')
    }
    const preparedUploads = await prepareLiveTestUploads(
      client, input.uploads ?? {},
      version.variableDefinitions as unknown as ComfyVariableDefinition[],
    )
    await guard.assertOwned()
    const rendered = renderComfyWorkflow({
      graph: version.apiFormatJson as unknown as ComfyApiWorkflow,
      variables: input.variables,
      variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
      bindings: versionBindings(version),
      uploads: preparedUploads,
    })
    const clientId = randomUUID()
    const { promptId } = await client.submitPrompt(rendered, clientId)
    await guard.assertOwned()
    let completed = false
    for await (const event of client.watchPrompt(promptId, clientId, guard.signal)) {
      if (event.type === 'execution_error') throw new ApiError('EXTERNAL_ERROR')
      if (event.type === 'executing' && event.nodeId === null) {
        completed = true
        break
      }
    }
    if (!completed) throw new ApiError('EXTERNAL_ERROR')
    await guard.assertOwned()
    const history = await client.getHistory(promptId)
    extractComfyOutputs(history, versionOutputs(version))
    await guard.assertOwned()
    const marker = await markSuccessfulWorkflowTest(userId, version.id, connection.id)
    try {
      await guard.assertOwned()
    } catch (error) {
      await restoreSuccessfulWorkflowTest(marker)
      throw error
    }
    return { versionId: version.id, connectionId: connection.id, promptId, success: true }
  } finally {
    await guard.stop()
    await releaseComfyLease(leaseKey, leaseValue).catch(() => undefined)
  }
}

function sameConnectionExecutionIdentity(left: ComfyConnection, right: ComfyConnection) {
  return left.normalizedBaseUrl === right.normalizedBaseUrl
    && left.authType === right.authType
    && left.authSecretEncrypted === right.authSecretEncrypted
    && left.enabled === right.enabled
}

async function restoreSuccessfulWorkflowTest(marker: {
  versionId: string
  workflowId: string
  connectionId: string
  testedAt: Date
  previousTestedAt: Date | null
  previousConnectionId: string | null
}) {
  await prisma.comfyWorkflowVersion.updateMany({
    where: {
      id: marker.versionId,
      workflowId: marker.workflowId,
      lastSuccessfulTestAt: marker.testedAt,
      lastTestConnectionId: marker.connectionId,
    },
    data: {
      lastSuccessfulTestAt: marker.previousTestedAt,
      lastTestConnectionId: marker.previousConnectionId,
    },
  })
}

async function prepareLiveTestUploads(
  client: ComfyClient,
  inputs: Record<string, LiveTestUploadPayload | LiveTestUploadPayload[]>,
  definitions: ComfyVariableDefinition[],
) {
  type Uploaded = Awaited<ReturnType<ComfyClient['uploadImage']>>
  const result: Record<string, Uploaded | Uploaded[]> = {}
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  let totalBytes = 0
  for (const [variable, rawPayload] of Object.entries(inputs)) {
    const definition = byName.get(variable)
    if (!definition || !['image_ref', 'image_ref_list', 'video_ref'].includes(definition.type)) {
      throw new ApiError('INVALID_PARAMS')
    }
    const payloads = Array.isArray(rawPayload) ? rawPayload : [rawPayload]
    if ((definition.type === 'image_ref_list') !== Array.isArray(rawPayload)) {
      throw new ApiError('INVALID_PARAMS')
    }
    const uploaded: Uploaded[] = []
    for (const payload of payloads) {
      const expectsVideo = definition.type === 'video_ref'
      if (expectsVideo !== payload.contentType.startsWith('video/')) {
        throw new ApiError('INVALID_PARAMS')
      }
      const bytes = decodeBoundedBase64(payload.base64)
      totalBytes += bytes.byteLength
      if (totalBytes > 32 * 1024 * 1024) throw new ApiError('INVALID_PARAMS')
      uploaded.push(await client.uploadImage({
        filename: `${randomUUID()}-${payload.filename}`,
        contentType: payload.contentType,
        bytes,
        subfolder: 'waoowaoo/live-tests',
        overwrite: false,
      }))
    }
    result[variable] = Array.isArray(rawPayload) ? uploaded : uploaded[0]
  }
  return result
}

function validationForVersion(version: ComfyWorkflowVersion) {
  return validateWorkflowContract({
    graph: version.apiFormatJson,
    variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
    bindings: versionBindings(version),
    outputs: versionOutputs(version),
  })
}

function versionBindings(version: ComfyWorkflowVersion) {
  return (
    version.bindingSpec ?? (version as unknown as { bindings?: unknown }).bindings
  ) as unknown as ComfyInputBinding[]
}

function versionOutputs(version: ComfyWorkflowVersion) {
  return (
    version.outputSpec ?? (version as unknown as { outputs?: unknown }).outputs
  ) as unknown as ComfyOutputBinding[]
}

async function assertCompatible(client: ComfyClient, version: ComfyWorkflowVersion) {
  const objectInfo = await client.getObjectInfo()
  const requirements = version.requirements as unknown as ComfyWorkflowRequirements
  const missingNodes = requirements.nodeClasses.filter((nodeClass) => !Object.hasOwn(objectInfo, nodeClass))
  if (missingNodes.length > 0) throw new ApiError('CONFLICT', { missingNodes })
  for (const candidate of requirements.candidateLoaderInputs) {
    const node = version.apiFormatJson as unknown as ComfyApiWorkflow
    const classType = node[candidate.nodeId]?.class_type
    if (!schemaAcceptsValue(classType ? objectInfo[classType] : undefined, candidate.inputName, candidate.value)) {
      throw new ApiError('CONFLICT', { missingModels: [candidate] })
    }
  }
}

function schemaAcceptsValue(schema: unknown, inputName: string, value: string): boolean {
  if (!isObject(schema) || !isObject(schema.input)) return false
  for (const sectionName of ['required', 'optional']) {
    const section = schema.input[sectionName]
    if (!isObject(section) || !Object.hasOwn(section, inputName)) continue
    const spec = section[inputName]
    if (!Array.isArray(spec) || !Array.isArray(spec[0])) return true
    if (spec[0].length === 0) return true
    return spec[0].includes(value)
  }
  return true
}

function connectionAuth(connection: ComfyConnection): ComfyConnectionAuth {
  if (connection.authType === 'none') return { type: 'none' }
  if (!connection.authSecretEncrypted) throw new ApiError('MISSING_CONFIG')
  let value: unknown
  try { value = JSON.parse(decryptApiKey(connection.authSecretEncrypted)) } catch {
    throw new ApiError('MISSING_CONFIG')
  }
  if (connection.authType === 'bearer' && isObject(value) && typeof value.token === 'string') {
    return { type: 'bearer', token: value.token }
  }
  if (connection.authType === 'basic' && isObject(value)
    && typeof value.username === 'string' && typeof value.password === 'string') {
    return { type: 'basic', username: value.username, password: value.password }
  }
  throw new ApiError('MISSING_CONFIG')
}

function readNetworkPolicy(): ComfyNetworkPolicyConfig {
  return {
    mode: process.env.COMFYUI_NETWORK_MODE === 'trusted' ? 'trusted' : 'allowlist',
    allowedHosts: commaList(process.env.COMFYUI_ALLOWED_HOSTS),
    allowedCidrs: commaList(process.env.COMFYUI_ALLOWED_CIDRS),
  }
}

function decodeBoundedBase64(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength === 0
    || buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new ApiError('INVALID_PARAMS')
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function mapComfyError(error: { code: ComfyError['code']; retryable: boolean }): ApiError {
  let code: 'MISSING_CONFIG' | 'INVALID_PARAMS' | 'GENERATION_TIMEOUT' | 'NETWORK_ERROR' | 'EXTERNAL_ERROR'
  if (error.code === COMFY_ERROR_CODE.AUTH_FAILED) code = 'MISSING_CONFIG'
  else if (error.code === COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID
    || error.code === COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID) code = 'INVALID_PARAMS'
  else if (error.code === COMFY_ERROR_CODE.EXECUTION_TIMEOUT) code = 'GENERATION_TIMEOUT'
  else if (error.code === COMFY_ERROR_CODE.CONNECTION_OFFLINE
    || error.code === COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED) code = 'NETWORK_ERROR'
  else code = 'EXTERNAL_ERROR'
  const mapped = new ApiError(code, { comfyCode: error.code })
  mapped.retryable = error.retryable || code === 'GENERATION_TIMEOUT' || code === 'NETWORK_ERROR'
  return mapped
}

const COMFY_ERROR_CODES = new Set<string>(Object.values(COMFY_ERROR_CODE))
function isComfyErrorLike(value: unknown): value is { code: ComfyError['code']; retryable: boolean } {
  return !!value && typeof value === 'object' && 'code' in value
    && typeof value.code === 'string' && COMFY_ERROR_CODES.has(value.code)
    && 'retryable' in value && typeof value.retryable === 'boolean'
}

function commaList(value: string | undefined) {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
