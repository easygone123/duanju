import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { workflowContractSchema } from '@/lib/comfyui/workflow-route-schema'
import { createWorkflowVersion } from '@/lib/comfyui/workflow-service'

type Context = { params: Promise<{ workflowId: string }> }

export const POST = apiHandler(async (request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const parsed = workflowContractSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const { workflowId } = await context.params
  const version = await createWorkflowVersion(
    auth.session.user.id,
    workflowId,
    parsed.data as Parameters<typeof createWorkflowVersion>[2],
  )
  return NextResponse.json({ version }, { status: 201 })
})
