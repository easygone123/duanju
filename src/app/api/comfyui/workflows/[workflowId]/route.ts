import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { archiveWorkflow, getOwnedWorkflow } from '@/lib/comfyui/workflow-service'

type Context = { params: Promise<{ workflowId: string }> }

export const GET = apiHandler(async (_request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId } = await context.params
  return NextResponse.json({ workflow: await getOwnedWorkflow(auth.session.user.id, workflowId) })
})

export const DELETE = apiHandler(async (_request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId } = await context.params
  await archiveWorkflow(auth.session.user.id, workflowId)
  return NextResponse.json({ success: true })
})
