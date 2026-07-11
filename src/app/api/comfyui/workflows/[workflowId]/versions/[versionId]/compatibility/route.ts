import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { listOwnedWorkflowCompatibility } from '@/lib/comfyui/workflow-compatibility-service'

type Context = { params: Promise<{ workflowId: string; versionId: string }> }

export const GET = apiHandler(async (_request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId, versionId } = await context.params
  return NextResponse.json({
    compatibility: await listOwnedWorkflowCompatibility(auth.session.user.id, workflowId, versionId),
  })
})
