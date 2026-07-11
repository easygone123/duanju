export const COMFYUI_ACCEPTANCE_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  'REQ-COMFYUI-AC-01': [
    'local-and-remote-url', 'online-idle', 'online-busy-owned', 'online-busy-external',
    'offline', 'auth-failed', 'workflow-incompatible',
  ],
  'REQ-COMFYUI-AC-02': [
    'arbitrary-image-api-format', 'arbitrary-video-api-format', 'placeholder',
    'typed-node-mapping', 'input-upload', 'primary-output-mapping',
  ],
  'REQ-COMFYUI-AC-03': [
    'project-image-default', 'project-video-default', 'image-task-override',
    'video-task-override', 'immutable-version-snapshot',
  ],
  'REQ-COMFYUI-AC-04': [
    'image-output-copied-to-storage', 'video-output-copied-to-storage',
    'existing-image-flow-url', 'existing-video-flow-url',
  ],
  'REQ-COMFYUI-AC-05': [
    'compatible-idle-preference', 'least-recently-assigned', 'per-instance-concurrency-one',
  ],
  'REQ-COMFYUI-AC-06': [
    'all-compatible-busy', 'waoowaoo-waiting-capacity', 'comfy-prompt-count-unchanged',
    'comfy-queue-count-unchanged',
  ],
  'REQ-COMFYUI-AC-07': [
    'manual-prompt-external-busy', 'scheduler-no-assignment', 'comfy-prompt-count-unchanged',
  ],
  'REQ-COMFYUI-AC-08': [
    'restart-after-acceptance', 'websocket-disconnect', 'queued-and-running-cancel',
    'transfer-failure-retry',
  ],
  'REQ-COMFYUI-AC-09': [
    'allowlist-unauthorized-block', 'trusted-explicit-choice', 'metadata-ssrf-always-blocked',
  ],
  'REQ-COMFYUI-AC-10': [
    'cross-user-connection-denied', 'cross-user-workflow-denied',
    'cross-user-task-denied', 'cross-user-output-denied',
  ],
  'REQ-COMFYUI-AC-11': [
    'comfyui-native-route', 'cloud-provider-route', 'strict-model-key',
    'existing-provider-regression',
  ],
} as const
