import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { publishWorkflowSchema } from '@/lib/comfyui/workflow-route-schema'
import { publishWorkflowVersion } from '@/lib/comfyui/workflow-service'
import { readBoundedJson } from '@/lib/comfyui/workflow-limits'

type Context = { params: Promise<{ workflowId: string }> }

export const POST = apiHandler(async (request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const parsed = publishWorkflowSchema.safeParse(await readBoundedJson(request, 16 * 1024))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const { workflowId } = await context.params
  await publishWorkflowVersion(auth.session.user.id, workflowId, parsed.data.versionId)
  return NextResponse.json({ success: true })
})
