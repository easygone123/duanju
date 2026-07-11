import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { ApiError } from '@/lib/api-errors'
import { archiveWorkflow, getOwnedWorkflow, updateOwnedWorkflowMetadata } from '@/lib/comfyui/workflow-service'
import { updateWorkflowMetadataSchema } from '@/lib/comfyui/workflow-route-schema'
import { readBoundedJson } from '@/lib/comfyui/workflow-limits'

type Context = { params: Promise<{ workflowId: string }> }

export const GET = apiHandler(async (_request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId } = await context.params
  return NextResponse.json({ workflow: await getOwnedWorkflow(auth.session.user.id, workflowId) })
})

export const PATCH = apiHandler(async (request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const parsed = updateWorkflowMetadataSchema.safeParse(await readBoundedJson(request, 16 * 1024))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const { workflowId } = await context.params
  return NextResponse.json({
    workflow: await updateOwnedWorkflowMetadata(auth.session.user.id, workflowId, parsed.data.name),
  })
})

export const DELETE = apiHandler(async (_request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId } = await context.params
  await archiveWorkflow(auth.session.user.id, workflowId)
  return NextResponse.json({ success: true })
})
