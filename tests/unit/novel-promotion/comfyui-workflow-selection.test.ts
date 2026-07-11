import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sanitizeComfyDiagnosticId } from '@/components/task/TaskStatusOverlay'
import { buildPanelRegenerationPayload } from '@/lib/query/mutations/storyboard-panel-mutations'

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const workspace = 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion'

describe('ComfyUI project and task workflow selection', () => {
  it('accepts only bounded structural diagnostic IDs', () => {
    expect(sanitizeComfyDiagnosticId('prompt_42-safe')).toBe('prompt_42-safe')
    expect(sanitizeComfyDiagnosticId('Bearer secret token')).toBeNull()
    expect(sanitizeComfyDiagnosticId('x'.repeat(129))).toBeNull()
  })

  it('offers tested ComfyUI workflows as image and video project defaults', () => {
    const source = read(`${workspace}/components/WorkspaceHeaderShell.tsx`)
    expect(source).toContain('comfyImageWorkflowId')
    expect(source).toContain('comfyVideoWorkflowId')
    expect(source).toContain("lastSuccessfulTestAt")
    expect(source).toContain("onUpdateConfigStrict('comfyImageWorkflowId'")
    expect(source).toContain("onUpdateConfigStrict('comfyVideoWorkflowId'")
    const container = read(`${workspace}/NovelPromotionWorkspace.tsx`)
    expect(container).toContain('onUpdateConfigStrict={vm.actions.handleUpdateConfigStrict}')
  })

  it('keeps cloud models while allowing a per-task ComfyUI override from user models', () => {
    const source = read(`${workspace}/components/video/panel-card/VideoPanelCardBody.tsx`)
    expect(source).toContain('videoModel.videoModelOptions')
    expect(source).toContain("option.provider === 'comfyui'")
    expect(source).toContain("option.provider !== 'comfyui'")
    expect(source).toContain('comfyui::')
    expect(source).toContain('onGenerateVideo')
  })

  it('omits an empty image override and submits an explicit ComfyUI model key unchanged', () => {
    expect(buildPanelRegenerationPayload('panel-1', undefined, undefined)).toEqual({ panelId: 'panel-1', count: 1 })
    expect(buildPanelRegenerationPayload('panel-1', 2, 'comfyui::workflow-1', { resolution: '4K' })).toEqual({
      panelId: 'panel-1', count: 2, imageModel: 'comfyui::workflow-1', generationOptions: { resolution: '4K' },
    })
  })

  it('separates capacity waiting from execution diagnostics', () => {
    const source = read('src/components/task/TaskStatusOverlay.tsx')
    expect(source).toContain("stage === 'waiting_capacity'")
    expect(source).toContain('capacityWaitMs')
    expect(source).toContain('executionMs')
    expect(source).toContain('transferMs')
  })

  it('shows only sanitized instance, workflow, node and prompt identifiers', () => {
    const source = read('src/components/task/TaskStatusOverlay.tsx')
    expect(source).toContain('sanitizeComfyDiagnosticId')
    expect(source).toContain('connectionId')
    expect(source).toContain('workflowId')
    expect(source).toContain('promptId')
    expect(source).not.toMatch(/credential|authorization|rawPrompt|apiFormatJson/)
  })
})
