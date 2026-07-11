import type { ComfyConnection } from '@prisma/client'
import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { checkComfyCompatibility, type ComfyCompatibilityCache } from './compatibility'
import { createOwnedComfyClient } from './connection-service'
import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyApiWorkflow, ComfyWorkflowRequirements } from './types'

const compatibilityCache: ComfyCompatibilityCache = new Map()
const COMPATIBILITY_CONCURRENCY = 4

export async function listOwnedWorkflowCompatibility(userId: string, workflowId: string, versionId: string) {
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: { id: workflowId, userId, status: { not: 'archived' } }, select: { id: true },
  })
  if (!workflow) throw new ApiError('NOT_FOUND')
  const version = await prisma.comfyWorkflowVersion.findFirst({ where: { id: versionId, workflowId } })
  if (!version) throw new ApiError('NOT_FOUND')
  const connections = await prisma.comfyConnection.findMany({
    where: { userId }, orderBy: { createdAt: 'asc' }, take: 500,
  })
  if (compatibilityCache.size > 10_000) compatibilityCache.clear()
  return mapWithConcurrency(connections, COMPATIBILITY_CONCURRENCY, async (connection) =>
    checkConnection(connection, version.contentHash,
      version.apiFormatJson as unknown as ComfyApiWorkflow,
      version.requirements as unknown as ComfyWorkflowRequirements))
}

async function checkConnection(
  connection: ComfyConnection,
  workflowHash: string,
  graph: ComfyApiWorkflow,
  requirements: ComfyWorkflowRequirements,
) {
  if (!connection.enabled) {
    return {
      connectionId: connection.id,
      connectionName: connection.name,
      status: 'disabled' as const,
      compatible: false,
      workflowHash,
      capabilityFingerprint: null,
    }
  }
  try {
    const client = createOwnedComfyClient(connection)
    await client.getSystemStats()
    const result = await checkComfyCompatibility({
      connectionId: connection.id, workflowHash, graph, requirements, client, cache: compatibilityCache,
    })
    return { connectionId: connection.id, connectionName: connection.name, status: 'online' as const, ...result }
  } catch (error) {
    const authFailed = (error instanceof ComfyError && error.code === COMFY_ERROR_CODE.AUTH_FAILED)
      || (error instanceof ApiError && error.code === 'MISSING_CONFIG')
    const incompatible = error instanceof ComfyError && error.code === COMFY_ERROR_CODE.WORKFLOW_INCOMPATIBLE
    return {
      connectionId: connection.id, connectionName: connection.name,
      status: authFailed ? 'auth_failed' as const : incompatible ? 'online' as const : 'offline' as const,
      compatible: false, missingNodes: [], missingModels: [], workflowHash,
      capabilityFingerprint: null,
    }
  }
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}
