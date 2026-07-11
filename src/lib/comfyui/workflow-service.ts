import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type ComfyConnection, type ComfyWorkflowVersion } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { decryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'

import { ComfyClient } from './client'
import { deriveComfyRequirements } from './workflow-requirements'
import { renderComfyWorkflow } from './workflow-renderer'
import { validateComfyApiWorkflow, validateWorkflowContract } from './workflow-schema'
import { authorizeComfyTarget, type ComfyNetworkPolicyConfig } from './network-policy'
import type {
  ComfyApiWorkflow,
  ComfyConnectionAuth,
  ComfyInputBinding,
  ComfyMediaType,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyVariableValue,
  ComfyWorkflowRequirements,
  WorkflowValidationIssue,
} from './types'

const TEST_LEASE_TTL_MS = 5 * 60 * 1000
const TEST_RUN_TIMEOUT_MS = 5 * 60 * 1000
const RELEASE_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export interface CreateVersionInput {
  apiFormatJson: unknown
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
}

export interface CreateWorkflowInput extends CreateVersionInput {
  name: string
  mediaType: ComfyMediaType
}

export interface LiveTestInput {
  versionId: string
  connectionId: string
  variables: Record<string, ComfyVariableValue | undefined>
}

export function parseWorkflowImport(value: unknown): unknown {
  if (typeof value !== 'string') return cloneJson(value)
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ApiError('INVALID_PARAMS', { message: 'Workflow import must contain valid JSON.' })
  }
}

export function canonicalWorkflowHash(input: CreateVersionInput): string {
  return createHash('sha256').update(stableJson({
    graph: parseWorkflowImport(input.apiFormatJson),
    variableDefinitions: input.variableDefinitions,
    bindings: input.bindings,
    outputs: input.outputs,
  })).digest('hex')
}

export async function listOwnedWorkflows(userId: string) {
  const records = await prisma.comfyWorkflow.findMany({
    where: { userId },
    include: { currentVersion: true, versions: { orderBy: { version: 'desc' } } },
    orderBy: { createdAt: 'asc' },
  })
  return records.map(toWorkflowDetail)
}

export async function getOwnedWorkflow(userId: string, workflowId: string) {
  const record = await prisma.comfyWorkflow.findFirst({
    where: { id: workflowId, userId },
    include: { currentVersion: true, versions: { orderBy: { version: 'desc' } } },
  })
  if (!record) throw new ApiError('NOT_FOUND')
  return toWorkflowDetail(record)
}

export async function createWorkflowDraft(userId: string, input: CreateWorkflowInput) {
  const prepared = prepareVersion(input)
  const record = await prisma.comfyWorkflow.create({
    data: {
      userId,
      name: input.name.trim(),
      mediaType: input.mediaType,
      status: 'draft',
      versions: { create: { version: 1, ...prepared.data } },
    },
    include: { currentVersion: true, versions: { orderBy: { version: 'desc' } } },
  })
  return toWorkflowDetail(record)
}

export async function createWorkflowVersion(
  userId: string,
  workflowId: string,
  input: CreateVersionInput,
) {
  const prepared = prepareVersion(input)
  try {
    return await prisma.$transaction(async (tx) => {
      const workflow = await tx.comfyWorkflow.findFirst({
        where: { id: workflowId, userId, status: { not: 'archived' } },
      })
      if (!workflow) throw new ApiError('NOT_FOUND')
      const latest = await tx.comfyWorkflowVersion.findFirst({
        where: { workflowId }, orderBy: { version: 'desc' }, select: { version: true },
      })
      return tx.comfyWorkflowVersion.create({
        data: { workflowId, version: (latest?.version ?? 0) + 1, ...prepared.data },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  } catch (error) {
    if (isPrismaCode(error, 'P2002') || isPrismaCode(error, 'P2034')) {
      throw new ApiError('CONFLICT')
    }
    throw error
  }
}

export async function publishWorkflowVersion(
  userId: string,
  workflowId: string,
  versionId: string,
) {
  await prisma.$transaction(async (tx) => {
    const workflow = await tx.comfyWorkflow.findFirst({
      where: { id: workflowId, userId, status: { not: 'archived' } },
    })
    if (!workflow) throw new ApiError('NOT_FOUND')
    const version = await tx.comfyWorkflowVersion.findFirst({
      where: { id: versionId, workflowId },
    })
    if (!version) throw new ApiError('NOT_FOUND')
    const issues = validationForVersion(version)
    if (issues.length > 0) throw new ApiError('INVALID_PARAMS', { validationIssues: issues })
    const publishedAt = new Date()
    const versionResult = await tx.comfyWorkflowVersion.updateMany({
      where: { id: versionId, workflowId, publishedAt: null }, data: { publishedAt },
    })
    if (versionResult.count === 0 && !version.publishedAt) throw new ApiError('CONFLICT')
    const workflowResult = await tx.comfyWorkflow.updateMany({
      where: { id: workflowId, userId, status: { not: 'archived' } },
      data: { currentVersionId: versionId, status: 'published' },
    })
    if (workflowResult.count !== 1) throw new ApiError('CONFLICT')
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export async function recordSuccessfulWorkflowTest(
  userId: string,
  versionId: string,
  connectionId: string,
) {
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: { id: versionId, workflow: { userId } },
    select: { id: true, workflowId: true },
  })
  if (!version) throw new ApiError('NOT_FOUND')
  const connection = await prisma.comfyConnection.findFirst({
    where: { id: connectionId, userId }, select: { id: true },
  })
  if (!connection) throw new ApiError('NOT_FOUND')
  const result = await prisma.comfyWorkflowVersion.updateMany({
    where: { id: versionId, workflowId: version.workflowId },
    data: { lastSuccessfulTestAt: new Date(), lastTestConnectionId: connectionId },
  })
  if (result.count !== 1) throw new ApiError('CONFLICT')
}

export async function archiveWorkflow(userId: string, workflowId: string) {
  await prisma.$transaction(async (tx) => {
    const workflow = await tx.comfyWorkflow.findFirst({ where: { id: workflowId, userId } })
    if (!workflow) throw new ApiError('NOT_FOUND')
    const defaults = await tx.projectComfyBinding.count({
      where: { userId, OR: [{ imageWorkflowId: workflowId }, { videoWorkflowId: workflowId }] },
    })
    if (defaults > 0) throw new ApiError('CONFLICT')
    const result = await tx.comfyWorkflow.updateMany({
      where: { id: workflowId, userId, status: { not: 'archived' } },
      data: { status: 'archived' },
    })
    if (result.count !== 1) throw new ApiError('CONFLICT')
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export async function assertWorkflowCanBeProjectDefault(
  userId: string,
  workflowId: string,
  mediaType: ComfyMediaType,
) {
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: { id: workflowId, userId, status: 'published', mediaType },
    include: {
      currentVersion: {
        include: { lastTestConnection: { select: { userId: true } } },
      },
    },
  })
  if (!workflow) throw new ApiError('NOT_FOUND')
  if (!workflow.currentVersion
    || !workflow.currentVersion.lastSuccessfulTestAt
    || workflow.currentVersion.lastTestConnection?.userId !== userId) {
    throw new ApiError('CONFLICT')
  }
  return workflow.currentVersion
}

export async function runOwnedWorkflowTest(
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

  await authorizeComfyTarget(connection.normalizedBaseUrl, readNetworkPolicy())
  const client = new ComfyClient({
    baseUrl: connection.normalizedBaseUrl,
    auth: connectionAuth(connection),
    networkPolicy: readNetworkPolicy(),
  })
  const queue = await client.getQueue()
  if (queue.running.length > 0 || queue.pending.length > 0) throw new ApiError('CONFLICT')
  const leaseKey = `comfy:lease:${connection.id}`
  if (await redis.get(leaseKey)) throw new ApiError('CONFLICT')
  await assertCompatible(client, version)

  const leaseValue = JSON.stringify({ type: 'test-run', id: randomUUID(), userId, workflowId })
  const acquired = await redis.set(leaseKey, leaseValue, 'PX', TEST_LEASE_TTL_MS, 'NX')
  if (acquired !== 'OK') throw new ApiError('CONFLICT')
  try {
    // Re-check the external queue after the atomic claim to close the probe/claim race.
    const claimedQueue = await client.getQueue()
    if (claimedQueue.running.length > 0 || claimedQueue.pending.length > 0) {
      throw new ApiError('CONFLICT')
    }
    const rendered = renderComfyWorkflow({
      graph: version.apiFormatJson as unknown as ComfyApiWorkflow,
      variables: input.variables,
      variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
      bindings: (
        version.bindingSpec ?? (version as unknown as { bindings?: unknown }).bindings
      ) as unknown as ComfyInputBinding[],
      uploads: {},
    })
    const clientId = randomUUID()
    const { promptId } = await client.submitPrompt(rendered, clientId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_RUN_TIMEOUT_MS)
    try {
      let completed = false
      for await (const event of client.watchPrompt(promptId, clientId, controller.signal)) {
        if (event.type === 'execution_error') throw new ApiError('EXTERNAL_ERROR')
        if (event.type === 'executing' && event.nodeId === null) {
          completed = true
          break
        }
      }
      if (!completed) throw new ApiError('EXTERNAL_ERROR')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    await recordSuccessfulWorkflowTest(userId, version.id, connection.id)
    return { versionId: version.id, connectionId: connection.id, promptId, success: true }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('INTERNAL_ERROR')
  } finally {
    await redis.eval(RELEASE_LEASE_SCRIPT, 1, leaseKey, leaseValue)
  }
}

function prepareVersion(input: CreateVersionInput) {
  const graph = parseWorkflowImport(input.apiFormatJson)
  const issues = validateWorkflowContract({
    graph, variableDefinitions: input.variableDefinitions, bindings: input.bindings, outputs: input.outputs,
  })
  let requirements: ComfyWorkflowRequirements = { nodeClasses: [], candidateLoaderInputs: [] }
  try {
    requirements = deriveComfyRequirements(validateComfyApiWorkflow(graph))
  } catch {
    // Invalid drafts remain saveable and expose the static issues to the editor.
  }
  return {
    issues,
    data: {
      apiFormatJson: graph as Prisma.InputJsonValue,
      variableDefinitions: input.variableDefinitions as unknown as Prisma.InputJsonValue,
      bindingSpec: input.bindings as unknown as Prisma.InputJsonValue,
      outputSpec: input.outputs as unknown as Prisma.InputJsonValue,
      requirements: requirements as unknown as Prisma.InputJsonValue,
      contentHash: canonicalWorkflowHash({ ...input, apiFormatJson: graph }),
    },
  }
}

function validationForVersion(version: ComfyWorkflowVersion): WorkflowValidationIssue[] {
  return validateWorkflowContract({
    graph: version.apiFormatJson,
    variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
    bindings: (
      version.bindingSpec ?? (version as unknown as { bindings?: unknown }).bindings
    ) as unknown as ComfyInputBinding[],
    outputs: (
      version.outputSpec ?? (version as unknown as { outputs?: unknown }).outputs
    ) as unknown as ComfyOutputBinding[],
  })
}

async function assertCompatible(client: ComfyClient, version: ComfyWorkflowVersion) {
  const objectInfo = await client.getObjectInfo()
  const requirements = version.requirements as unknown as ComfyWorkflowRequirements
  const missingNodes = requirements.nodeClasses.filter((nodeClass) => !Object.hasOwn(objectInfo, nodeClass))
  if (missingNodes.length > 0) throw new ApiError('CONFLICT', { missingNodes })
  for (const candidate of requirements.candidateLoaderInputs) {
    const node = version.apiFormatJson as unknown as ComfyApiWorkflow
    const classType = node[candidate.nodeId]?.class_type
    const schema = classType ? objectInfo[classType] : undefined
    if (!schemaAcceptsValue(schema, candidate.inputName, candidate.value)) {
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
    return spec[0].includes(value)
  }
  return false
}

function connectionAuth(connection: ComfyConnection): ComfyConnectionAuth {
  if (connection.authType === 'none') return { type: 'none' }
  if (!connection.authSecretEncrypted) throw new ApiError('MISSING_CONFIG')
  let value: unknown
  try {
    value = JSON.parse(decryptApiKey(connection.authSecretEncrypted))
  } catch {
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

function toWorkflowDetail(record: Record<string, unknown>) {
  const versions = Array.isArray(record.versions) ? record.versions : []
  const versionDetails = versions.map((item) => toVersionDetail(item as Record<string, unknown>))
  return {
    id: record.id, name: record.name, mediaType: record.mediaType, status: record.status,
    currentVersionId: record.currentVersionId ?? null,
    createdAt: asIso(record.createdAt), updatedAt: asIso(record.updatedAt),
    currentVersion: record.currentVersion ? toVersionDetail(record.currentVersion as Record<string, unknown>) : null,
    versions: versionDetails,
    validation: versionDetails[0]?.validation ?? { valid: false, issues: [] },
  }
}

function toVersionDetail(version: Record<string, unknown>) {
  const shaped = {
    id: version.id, workflowId: version.workflowId, version: version.version,
    apiFormatJson: version.apiFormatJson,
    variableDefinitions: version.variableDefinitions,
    bindings: version.bindingSpec ?? version.bindings,
    outputs: version.outputSpec ?? version.outputs,
    requirements: version.requirements, contentHash: version.contentHash,
    publishedAt: asIso(version.publishedAt), lastSuccessfulTestAt: asIso(version.lastSuccessfulTestAt),
    lastTestConnectionId: version.lastTestConnectionId ?? null, createdAt: asIso(version.createdAt),
  }
  const issues = validateWorkflowContract({
    graph: shaped.apiFormatJson,
    variableDefinitions: shaped.variableDefinitions as ComfyVariableDefinition[],
    bindings: shaped.bindings as ComfyInputBinding[],
    outputs: shaped.outputs as ComfyOutputBinding[],
  })
  return { ...shaped, validation: { valid: issues.length === 0, issues } }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function commaList(value: string | undefined) {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function asIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function isPrismaCode(error: unknown, code: string) {
  return isObject(error) && error.code === code
}
