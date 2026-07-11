import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { testWorkflowSchema } from '@/lib/comfyui/workflow-route-schema'
import { runOwnedWorkflowTest } from '@/lib/comfyui/workflow-service'

type Context = { params: Promise<{ workflowId: string }> }

export const POST = apiHandler(async (request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const parsed = testWorkflowSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const { workflowId } = await context.params
  const result = await runOwnedWorkflowTest(
    auth.session.user.id,
    workflowId,
    parsed.data as Parameters<typeof runOwnedWorkflowTest>[2],
  )
  return NextResponse.json({ result })
})
