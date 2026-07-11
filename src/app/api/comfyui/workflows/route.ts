import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { createWorkflowSchema } from '@/lib/comfyui/workflow-route-schema'
import { createWorkflowDraft, listOwnedWorkflows } from '@/lib/comfyui/workflow-service'

export const GET = apiHandler(async () => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  return NextResponse.json({ workflows: await listOwnedWorkflows(auth.session.user.id) })
})

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const parsed = createWorkflowSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const workflow = await createWorkflowDraft(auth.session.user.id, parsed.data as Parameters<typeof createWorkflowDraft>[1])
  return NextResponse.json({ workflow }, { status: 201 })
})
