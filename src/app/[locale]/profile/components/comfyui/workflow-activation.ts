export type WorkflowActivationStatus = 'draft' | 'needs_test' | 'ready_to_publish' | 'available'
export type WorkflowActivationEvent =
  | 'test_started'
  | 'test_succeeded'
  | 'test_failed'
  | 'publish_started'
  | 'publish_succeeded'
  | 'publish_failed'

export interface WorkflowActivationState {
  status: WorkflowActivationStatus
  testComplete: boolean
  publishRequired: boolean
  busy: 'testing' | 'publishing' | null
  error: 'test' | 'publish' | null
}

export function initialWorkflowActivationState(options: { valid?: boolean; published?: boolean; tested?: boolean } = {}): WorkflowActivationState {
  if (options.valid === false) return { status: 'draft', testComplete: false, publishRequired: false, busy: null, error: null }
  if (options.published) return { status: 'available', testComplete: true, publishRequired: false, busy: null, error: null }
  if (options.tested) return { status: 'ready_to_publish', testComplete: true, publishRequired: true, busy: null, error: null }
  return { status: 'needs_test', testComplete: false, publishRequired: false, busy: null, error: null }
}

export function nextWorkflowActivationState(
  state: WorkflowActivationState,
  event: WorkflowActivationEvent,
): WorkflowActivationState {
  switch (event) {
    case 'test_started':
      return { status: 'needs_test', testComplete: false, publishRequired: false, busy: 'testing', error: null }
    case 'test_succeeded':
      return { status: 'ready_to_publish', testComplete: true, publishRequired: true, busy: null, error: null }
    case 'test_failed':
      return { status: 'needs_test', testComplete: false, publishRequired: false, busy: null, error: 'test' }
    case 'publish_started':
      return { status: 'ready_to_publish', testComplete: true, publishRequired: true, busy: 'publishing', error: null }
    case 'publish_succeeded':
      return { status: 'available', testComplete: true, publishRequired: false, busy: null, error: null }
    case 'publish_failed':
      return { status: 'ready_to_publish', testComplete: true, publishRequired: true, busy: null, error: 'publish' }
  }
}
