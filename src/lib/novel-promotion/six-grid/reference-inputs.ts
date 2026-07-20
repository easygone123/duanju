import { COMFY_REFERENCE_UPLOAD_LIMIT } from '@/lib/comfyui/types'
import {
  collectPanelReferenceImageEntries,
  resolveNovelData,
  type PanelReferenceImageEntry,
} from '@/lib/workers/handlers/image-task-handler-shared'

type ProjectData = Awaited<ReturnType<typeof resolveNovelData>>
type PanelInput = Parameters<typeof collectPanelReferenceImageEntries>[1]

interface ReferenceInputDependencies {
  resolveProjectData(projectId: string): Promise<ProjectData>
  collectPanel(projectData: ProjectData, panel: PanelInput): Promise<PanelReferenceImageEntry[]>
}

export interface SixGridReferenceInput {
  source: string
  kind: PanelReferenceImageEntry['kind']
  name: string
}

const defaultDependencies: ReferenceInputDependencies = {
  resolveProjectData: resolveNovelData,
  collectPanel: collectPanelReferenceImageEntries,
}

export async function collectSixGridReferenceInputs(
  input: { projectId: string; panels: PanelInput[] },
  dependencies: ReferenceInputDependencies = defaultDependencies,
): Promise<SixGridReferenceInput[]> {
  const projectData = await dependencies.resolveProjectData(input.projectId)
  const collectedByKind: Record<SixGridReferenceInput['kind'], SixGridReferenceInput[]> = {
    character: [],
    location: [],
    prop: [],
    sketch: [],
  }
  const seen = new Set<string>()
  for (const panel of input.panels) {
    const entries = await dependencies.collectPanel(projectData, panel)
    for (const entry of entries) {
      if (seen.has(entry.source)) continue
      seen.add(entry.source)
      collectedByKind[entry.kind].push({
        source: entry.source,
        kind: entry.kind,
        name: entry.name,
      })
    }
  }
  return [
    ...collectedByKind.character,
    ...collectedByKind.location,
    ...collectedByKind.prop,
    ...collectedByKind.sketch,
  ].slice(0, COMFY_REFERENCE_UPLOAD_LIMIT)
}
