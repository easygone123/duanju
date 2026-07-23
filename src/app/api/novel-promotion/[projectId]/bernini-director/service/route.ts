import { NextRequest, NextResponse } from 'next/server'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { createOwnedComfyClient } from '@/lib/comfyui/connection-service'
import { hasBerniniDirectorNode } from '@/lib/comfyui/bernini-director-contract'
import { isExecutableOwnedWorkflow } from '@/lib/comfyui/workflow-model-option'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { prisma } from '@/lib/prisma'

const ACTIONS = ['enhance_models', 'get_template', 'enhance', 'unload_model'] as const
type BerniniServiceAction = typeof ACTIONS[number]

interface RequestBody {
  videoModel?: unknown
  action?: unknown
  payload?: unknown
}

function serviceAction(value: unknown): BerniniServiceAction | null {
  return typeof value === 'string' && ACTIONS.includes(value as BerniniServiceAction)
    ? value as BerniniServiceAction
    : null
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as RequestBody | null
  const action = serviceAction(body?.action)
  const model = typeof body?.videoModel === 'string' ? body.videoModel.trim() : ''
  const parsed = parseModelKeyStrict(model)
  if (!action || parsed?.provider !== 'comfyui') {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_SERVICE_INVALID' })
  }
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: {
      id: parsed.modelId,
      userId: auth.session.user.id,
      mediaType: 'video',
      status: 'published',
      currentVersionId: { not: null },
    },
    include: {
      currentVersion: {
        include: { lastTestConnection: true },
      },
    },
  })
  if (!workflow || !isExecutableOwnedWorkflow(workflow, auth.session.user.id)
    || !hasBerniniDirectorNode(workflow.currentVersion?.apiFormatJson)
    || !workflow.currentVersion?.lastTestConnection
    || !workflow.currentVersion.lastTestConnection.enabled) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_MODEL_INVALID' })
  }
  const payload = body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : {}
  const client = createOwnedComfyClient(workflow.currentVersion.lastTestConnection)
  const result = await client.postBerniniDirector<Record<string, unknown>>(action, payload)
  return NextResponse.json(result)
})
