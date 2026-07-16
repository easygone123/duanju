import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { prisma } from '@/lib/prisma'
import { isExecutableOwnedWorkflow } from './workflow-model-option'

export const COMFY_DEFAULT_MEDIA_BY_FIELD = {
  characterModel: 'image',
  locationModel: 'image',
  storyboardModel: 'image',
  editModel: 'image',
  videoModel: 'video',
} as const

export type ComfyDefaultModelField =
  | keyof typeof COMFY_DEFAULT_MEDIA_BY_FIELD
  | 'analysisModel'
  | 'audioModel'
  | 'lipSyncModel'
  | 'voiceDesignModel'

export interface InvalidComfyDefaultModel {
  field: ComfyDefaultModelField
  modelKey: string
}

export interface ComfyDefaultModelValidation {
  validModelKeys: Set<string>
  invalidEntries: InvalidComfyDefaultModel[]
}

type DefaultModelValues = Partial<Record<ComfyDefaultModelField, string | null | undefined>>

function expectedMediaType(field: ComfyDefaultModelField): 'image' | 'video' | null {
  return field in COMFY_DEFAULT_MEDIA_BY_FIELD
    ? COMFY_DEFAULT_MEDIA_BY_FIELD[field as keyof typeof COMFY_DEFAULT_MEDIA_BY_FIELD]
    : null
}

export async function validateComfyDefaultModels(
  userId: string,
  defaultModels: DefaultModelValues,
): Promise<ComfyDefaultModelValidation> {
  const references: Array<{
    field: ComfyDefaultModelField
    modelKey: string
    workflowId: string
    mediaType: 'image' | 'video' | null
  }> = []

  for (const [field, rawModelKey] of Object.entries(defaultModels) as Array<[
    ComfyDefaultModelField,
    string | null | undefined,
  ]>) {
    const parsed = parseModelKeyStrict(rawModelKey)
    if (parsed?.provider !== 'comfyui') continue
    references.push({
      field,
      modelKey: parsed.modelKey,
      workflowId: parsed.modelId,
      mediaType: expectedMediaType(field),
    })
  }

  const queryableWorkflowIds = [...new Set(
    references
      .filter((reference) => reference.mediaType !== null)
      .map((reference) => reference.workflowId),
  )]
  const workflows = queryableWorkflowIds.length > 0
    ? await prisma.comfyWorkflow.findMany({
        where: {
          id: { in: queryableWorkflowIds },
          userId,
        },
        select: {
          id: true,
          userId: true,
          status: true,
          mediaType: true,
          currentVersionId: true,
          currentVersion: {
            select: {
              id: true,
              purpose: true,
              publishedAt: true,
              contentHash: true,
              lastSuccessfulTestAt: true,
              lastTestConnection: { select: { userId: true } },
            },
          },
        },
      })
    : []
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]))
  const validModelKeys = new Set<string>()
  const invalidEntries: InvalidComfyDefaultModel[] = []

  for (const reference of references) {
    const workflow = workflowById.get(reference.workflowId)
    const isValid = reference.mediaType !== null
      && workflow?.userId === userId
      && workflow.status === 'published'
      && workflow.mediaType === reference.mediaType
      && workflow.currentVersion?.purpose === 'generation'
      && isExecutableOwnedWorkflow(workflow, userId)

    if (isValid) {
      validModelKeys.add(reference.modelKey)
    } else {
      invalidEntries.push({ field: reference.field, modelKey: reference.modelKey })
    }
  }

  return { validModelKeys, invalidEntries }
}
