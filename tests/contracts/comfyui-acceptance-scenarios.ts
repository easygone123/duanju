export interface AcceptanceScenarioEvidence {
  acId: string
  scenarioId: string
  file: string
  testTitle: string
}

const SYSTEM = 'tests/system/comfyui-generation.system.test.ts'

export const COMFYUI_ACCEPTANCE_SCENARIO_EVIDENCE: readonly AcceptanceScenarioEvidence[] = [
  { acId: 'REQ-COMFYUI-AC-01', scenarioId: 'local-and-remote-url-add', file: 'tests/integration/api/specific/comfyui-connections-route.test.ts', testTitle: 'AC01 creates local and remote private connections with normalized owner-visible status' },
  { acId: 'REQ-COMFYUI-AC-01', scenarioId: 'states', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-01 reports idle, owned busy, external busy, offline, auth, and incompatible states' },
  { acId: 'REQ-COMFYUI-AC-02', scenarioId: 'arbitrary-image-video-workflows', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-02 imports arbitrary image/video API Format mappings, uploads, and outputs' },
  { acId: 'REQ-COMFYUI-AC-03', scenarioId: 'task-override-fixed-version', file: 'tests/integration/api/specific/project-comfyui-defaults.test.ts', testTitle: 'AC03 task override wins and snapshots its fixed workflow version' },
  { acId: 'REQ-COMFYUI-AC-03', scenarioId: 'project-comfy-default-fixed-version', file: 'tests/integration/api/specific/project-comfyui-defaults.test.ts', testTitle: 'AC03 project Comfy default wins and keeps its pinned workflow version' },
  { acId: 'REQ-COMFYUI-AC-03', scenarioId: 'specialized-project-default', file: 'tests/integration/api/specific/project-comfyui-defaults.test.ts', testTitle: 'AC03 specialized project provider model wins when no Comfy default exists' },
  { acId: 'REQ-COMFYUI-AC-03', scenarioId: 'user-default', file: 'tests/integration/api/specific/project-comfyui-defaults.test.ts', testTitle: 'AC03 user default is used only when project and Comfy defaults are absent' },
  { acId: 'REQ-COMFYUI-AC-04', scenarioId: 'image-video-storage-existing-flows', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-04 copies image/video outputs to storage and returns them through existing media flows' },
  { acId: 'REQ-COMFYUI-AC-05', scenarioId: 'compatible-idle-preference', file: 'tests/concurrency/comfyui/scheduler.concurrency.test.ts', testTitle: 'keeps FIFO per user and chooses the least recently assigned compatible idle node' },
  { acId: 'REQ-COMFYUI-AC-05', scenarioId: 'least-recently-assigned', file: 'tests/concurrency/comfyui/scheduler.concurrency.test.ts', testTitle: 'keeps FIFO per user and chooses the least recently assigned compatible idle node' },
  { acId: 'REQ-COMFYUI-AC-05', scenarioId: 'per-instance-concurrency-one', file: 'tests/concurrency/comfyui/scheduler.concurrency.test.ts', testTitle: 'gives two schedulers one winner through the real memory Redis and DB CAS gates' },
  { acId: 'REQ-COMFYUI-AC-06', scenarioId: 'all-busy-waoowaoo-wait', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-06 keeps requests in waoowaoo when all compatible instances are busy' },
  { acId: 'REQ-COMFYUI-AC-07', scenarioId: 'manual-prompt-external-busy', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-07 treats a manual prompt as external busy and makes no assignment' },
  { acId: 'REQ-COMFYUI-AC-08', scenarioId: 'restart-ws-cancel-transfer-recovery', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-08 avoids duplicate execution across restart, WS loss, cancel, and transfer failure' },
  { acId: 'REQ-COMFYUI-AC-09', scenarioId: 'allowlist-trusted-ssrf', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-09 defaults to trusted while preserving allowlist and metadata protections' },
  { acId: 'REQ-COMFYUI-AC-10', scenarioId: 'cross-user-resource-isolation', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-10 denies cross-user connections, workflows, tasks, and outputs' },
  { acId: 'REQ-COMFYUI-AC-11', scenarioId: 'comfy-cloud-provider-coexistence', file: SYSTEM, testTitle: 'REQ-COMFYUI-AC-11 preserves strict ComfyUI and cloud provider coexistence without provider guessing' },
] as const
