import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  analyzeComfyApiWorkflow,
  WORKFLOW_AUTO_MAPPING_ERROR,
  WorkflowAutoMappingError,
} from '@/lib/comfyui/workflow-auto-mapper'
import { analyzeWorkflowSchema } from '@/lib/comfyui/workflow-route-schema'
import {
  assertBoundedWorkflowJson,
  MAX_WORKFLOW_JSON_BYTES,
  readBoundedJson,
} from '@/lib/comfyui/workflow-limits'

const MAX_ANALYZE_REQUEST_BYTES = MAX_WORKFLOW_JSON_BYTES + 64 * 1024

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  const parsed = analyzeWorkflowSchema.safeParse(
    await readBoundedJson(request, MAX_ANALYZE_REQUEST_BYTES),
  )
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')

  const graph = parseUploadedGraph(parsed.data.apiFormatJson)
  assertBoundedWorkflowJson(graph)

  try {
    const analysis = analyzeComfyApiWorkflow({ graph, kind: parsed.data.kind })
    return NextResponse.json({ analysis })
  } catch (error) {
    if (error instanceof WorkflowAutoMappingError) {
      throw new ApiError('INVALID_PARAMS', { reason: error.code })
    }
    throw new ApiError('INVALID_PARAMS', {
      reason: WORKFLOW_AUTO_MAPPING_ERROR.API_FORMAT_INVALID,
    })
  }
})

function parseUploadedGraph(value: string | Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ApiError('INVALID_PARAMS', {
      reason: WORKFLOW_AUTO_MAPPING_ERROR.API_FORMAT_INVALID,
    })
  }
}
