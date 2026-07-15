import { createHash } from 'node:crypto'
import { Prisma, type ComfyWorkflowVersion } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import { deriveComfyRequirements } from './workflow-requirements'
import { validateComfyApiWorkflow, validateWorkflowContract } from './workflow-schema'
import { assertBoundedWorkflowContract, assertBoundedWorkflowJson } from './workflow-limits'
import type {
  ComfyInputBinding,
  ComfyMediaType,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyWorkflowPurpose,
  ComfyWorkflowRequirements,
  WorkflowValidationIssue,
} from './types'

export {
  recordSuccessfulWorkflowTest,
  runOwnedWorkflowTest,
} from './workflow-test-service'
export type { LiveTestInput, LiveTestUploadPayload } from './workflow-test-service'

export interface CreateVersionInput {
  purpose?: ComfyWorkflowPurpose
  apiFormatJson: unknown
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
}

export interface CreateWorkflowInput extends CreateVersionInput {
  creationId: string
  name: string
  mediaType: ComfyMediaType
}


export function parseWorkflowImport(value: unknown): unknown {
  if (typeof value !== 'string') {
    assertBoundedWorkflowJson(value)
    return cloneJson(value)
  }
  if (Buffer.byteLength(value, 'utf8') > 4 * 1024 * 1024) throw new ApiError('INVALID_PARAMS')
  try {
    const parsed = JSON.parse(value) as unknown
    assertBoundedWorkflowJson(parsed)
    return parsed
  } catch {
    throw new ApiError('INVALID_PARAMS', { message: 'Workflow import must contain valid JSON.' })
  }
}

export function canonicalWorkflowHash(input: CreateVersionInput): string {
  const purpose = input.purpose ?? 'generation'
  const graph = parseWorkflowImport(input.apiFormatJson)
  assertBoundedWorkflowContract({
    purpose,
    graph,
    variableDefinitions: input.variableDefinitions,
    bindings: input.bindings,
    outputs: input.outputs,
  })
  return createHash('sha256').update(stableJson({
    purpose,
    graph,
    variableDefinitions: input.variableDefinitions,
    bindings: input.bindings,
    outputs: input.outputs,
  })).digest('hex')
}

export async function listOwnedWorkflows(userId: string) {
  const records = await prisma.comfyWorkflow.findMany({
    where: { userId, status: { not: 'archived' } },
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

export async function updateOwnedWorkflowMetadata(userId: string, workflowId: string, name: string) {
  const result = await prisma.comfyWorkflow.updateMany({
    where: { id: workflowId, userId, status: { not: 'archived' } },
    data: { name: name.trim() },
  })
  if (result.count !== 1) throw new ApiError('NOT_FOUND')
  return getOwnedWorkflow(userId, workflowId)
}

export async function createWorkflowDraft(userId: string, input: CreateWorkflowInput) {
  const purpose = input.purpose ?? 'generation'
  const prepared = prepareVersion({ ...input, purpose })
  const include = { currentVersion: true, versions: { orderBy: { version: 'desc' as const } } }
  try {
    const record = await prisma.comfyWorkflow.create({
      data: {
        id: input.creationId,
        userId,
        name: input.name.trim(),
        mediaType: input.mediaType,
        status: 'draft',
        versions: { create: { version: 1, ...prepared.data } },
      },
      include,
    })
    return toWorkflowDetail(record)
  } catch (error) {
    if (!isPrismaCode(error, 'P2002')) throw error
    const existing = await prisma.comfyWorkflow.findFirst({
      where: { id: input.creationId, userId },
      include,
    })
    if (!existing || !matchesIdempotentCreation(existing, input, purpose, prepared.data)) {
      throw new ApiError('CONFLICT')
    }
    return toWorkflowDetail(existing)
  }
}

export async function createWorkflowVersion(
  userId: string,
  workflowId: string,
  input: CreateVersionInput,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const workflow = await tx.comfyWorkflow.findFirst({
        where: { id: workflowId, userId, status: { not: 'archived' } },
      })
      if (!workflow) throw new ApiError('NOT_FOUND')
      const latest = await tx.comfyWorkflowVersion.findFirst({
        where: { workflowId }, orderBy: { version: 'desc' },
        select: { version: true, purpose: true },
      })
      const purpose = input.purpose ?? (
        latest?.purpose === 'upscale' ? 'upscale' : 'generation'
      )
      if (latest && latest.purpose !== purpose) throw new ApiError('INVALID_PARAMS')
      const prepared = prepareVersion({ ...input, purpose })
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
    if ((version.purpose ?? 'generation') === 'upscale' && workflow.mediaType !== 'image') {
      issues.push({
        code: 'COMFY_UPSCALE_BINDINGS_INVALID', path: 'mediaType',
        message: 'Upscale workflows must use image media type.',
      })
    }
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

export async function archiveWorkflow(userId: string, workflowId: string) {
  await prisma.$transaction(async (tx) => {
    const workflow = await tx.comfyWorkflow.findFirst({ where: { id: workflowId, userId } })
    if (!workflow) throw new ApiError('NOT_FOUND')
    const defaults = await tx.projectComfyBinding.count({
      where: { userId, OR: [{ imageWorkflowId: workflowId }, { videoWorkflowId: workflowId }] },
    })
    if (defaults > 0) {
      throw new ApiError('CONFLICT', { reason: 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT' })
    }
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
  return prisma.$transaction(async (tx) => assertWorkflowCanBeProjectDefaultInTransaction(
    tx, userId, workflowId, mediaType,
  ), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

async function assertWorkflowCanBeProjectDefaultInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  workflowId: string,
  mediaType: ComfyMediaType,
) {
  const workflow = await tx.comfyWorkflow.findFirst({
    where: {
      id: workflowId, userId, status: 'published', mediaType,
      currentVersion: { is: { purpose: 'generation' } },
    },
    include: {
      currentVersion: {
        include: { lastTestConnection: { select: { userId: true } } },
      },
    },
  })
  if (!workflow) throw new ApiError('NOT_FOUND')
  if (!workflow.currentVersion
    || !workflow.currentVersion.publishedAt
    || !workflow.currentVersion.lastSuccessfulTestAt
    || workflow.currentVersion.lastTestConnection?.userId !== userId) {
    throw new ApiError('CONFLICT')
  }
  return workflow.currentVersion
}

export async function bindProjectDefaultWorkflow(
  userId: string,
  projectId: string,
  mediaType: ComfyMediaType,
  workflowId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ApiError('NOT_FOUND')
    const version = workflowId
      ? await assertWorkflowCanBeProjectDefaultInTransaction(tx, userId, workflowId, mediaType)
      : null
    const field = mediaType === 'image' ? 'imageWorkflowId' : 'videoWorkflowId'
    const versionField = mediaType === 'image' ? 'imageWorkflowVersionId' : 'videoWorkflowVersionId'
    return tx.projectComfyBinding.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, [field]: workflowId, [versionField]: version?.id ?? null },
      update: { [field]: workflowId, [versionField]: version?.id ?? null },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

export interface UpdateProjectWithComfyDefaultsInput {
  userId: string
  projectId: string
  projectData: Prisma.NovelPromotionProjectUncheckedUpdateInput
  imageWorkflowId?: string | null
  videoWorkflowId?: string | null
}

const PROJECT_DEFAULT_UPDATE_ATTEMPTS = 3

export async function updateProjectWithComfyDefaults(input: UpdateProjectWithComfyDefaultsInput) {
  for (let attempt = 1; attempt <= PROJECT_DEFAULT_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({ where: { id: input.projectId, userId: input.userId } })
        if (!project) throw new ApiError('NOT_FOUND')
        const novelProject = await tx.novelPromotionProject.findUnique({ where: { projectId: input.projectId } })
        if (!novelProject) throw new ApiError('NOT_FOUND')

        const bindingData: Record<string, string | null> = {}
        if (Object.hasOwn(input, 'imageWorkflowId')) {
          const version = input.imageWorkflowId
            ? await assertWorkflowCanBeProjectDefaultInTransaction(tx, input.userId, input.imageWorkflowId, 'image')
            : null
          bindingData.imageWorkflowId = input.imageWorkflowId ?? null
          bindingData.imageWorkflowVersionId = version?.id ?? null
        }
        if (Object.hasOwn(input, 'videoWorkflowId')) {
          const version = input.videoWorkflowId
            ? await assertWorkflowCanBeProjectDefaultInTransaction(tx, input.userId, input.videoWorkflowId, 'video')
            : null
          bindingData.videoWorkflowId = input.videoWorkflowId ?? null
          bindingData.videoWorkflowVersionId = version?.id ?? null
        }
        if (Object.keys(bindingData).length > 0) {
          await tx.projectComfyBinding.upsert({
            where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
            create: { projectId: input.projectId, userId: input.userId, ...bindingData },
            update: bindingData,
          })
        }
        const updated = Object.keys(input.projectData).length > 0
          ? await tx.novelPromotionProject.update({
            where: { projectId: input.projectId }, data: input.projectData,
          })
          : novelProject
        return { novelPromotionProject: updated }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < PROJECT_DEFAULT_UPDATE_ATTEMPTS) continue
      if (isPrismaCode(error, 'P2034')) throw new ApiError('CONFLICT')
      throw error
    }
  }
  throw new ApiError('CONFLICT')
}

function prepareVersion(input: CreateVersionInput & { purpose: ComfyWorkflowPurpose }) {
  const graph = parseWorkflowImport(input.apiFormatJson)
  assertBoundedWorkflowContract({
    purpose: input.purpose,
    graph,
    variableDefinitions: input.variableDefinitions,
    bindings: input.bindings,
    outputs: input.outputs,
  })
  const issues = validateWorkflowContract({
    purpose: input.purpose,
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
      purpose: input.purpose,
      apiFormatJson: graph as Prisma.InputJsonValue,
      variableDefinitions: input.variableDefinitions as unknown as Prisma.InputJsonValue,
      bindingSpec: input.bindings as unknown as Prisma.InputJsonValue,
      outputSpec: input.outputs as unknown as Prisma.InputJsonValue,
      requirements: requirements as unknown as Prisma.InputJsonValue,
      contentHash: canonicalWorkflowHash({ ...input, apiFormatJson: graph }),
    },
  }
}

function matchesIdempotentCreation(
  record: Record<string, unknown>,
  input: CreateWorkflowInput,
  purpose: ComfyWorkflowPurpose,
  prepared: ReturnType<typeof prepareVersion>['data'],
) {
  if (record.name !== input.name.trim() || record.mediaType !== input.mediaType) return false
  const versions = Array.isArray(record.versions) ? record.versions : []
  const version = versions.find((item) => isObject(item) && item.version === 1)
  if (!version || version.purpose !== purpose || version.contentHash !== prepared.contentHash) return false
  return stableJson(version.apiFormatJson) === stableJson(prepared.apiFormatJson)
    && stableJson(version.variableDefinitions) === stableJson(prepared.variableDefinitions)
    && stableJson(version.bindingSpec ?? version.bindings) === stableJson(prepared.bindingSpec)
    && stableJson(version.outputSpec ?? version.outputs) === stableJson(prepared.outputSpec)
}

function validationForVersion(version: ComfyWorkflowVersion): WorkflowValidationIssue[] {
  return validateWorkflowContract({
    purpose: (version.purpose ?? 'generation') as ComfyWorkflowPurpose,
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

function toWorkflowDetail(record: Record<string, unknown>) {
  const versions = Array.isArray(record.versions) ? record.versions : []
  const versionDetails = versions.map((item) => toVersionDetail(item as Record<string, unknown>))
  return {
    id: record.id, name: record.name, mediaType: record.mediaType, status: record.status,
    purpose: versionDetails[0]?.purpose ?? 'generation',
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
    purpose: (version.purpose === 'upscale' ? 'upscale' : 'generation') as ComfyWorkflowPurpose,
    apiFormatJson: version.apiFormatJson,
    variableDefinitions: version.variableDefinitions,
    bindings: version.bindingSpec ?? version.bindings,
    outputs: version.outputSpec ?? version.outputs,
    requirements: version.requirements, contentHash: version.contentHash,
    publishedAt: asIso(version.publishedAt), lastSuccessfulTestAt: asIso(version.lastSuccessfulTestAt),
    lastTestConnectionId: version.lastTestConnectionId ?? null, createdAt: asIso(version.createdAt),
  }
  const issues = validateWorkflowContract({
    purpose: shaped.purpose,
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

function asIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function isPrismaCode(error: unknown, code: string) {
  return isObject(error) && error.code === code
}
