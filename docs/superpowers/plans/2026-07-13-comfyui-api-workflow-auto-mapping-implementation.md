# ComfyUI API Workflow Auto-Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an upload-first ComfyUI API Format workflow wizard that deterministically maps only waoowaoo canonical inputs, confirms ambiguous media roles, and enforces the confirmed binding capacity before task submission.

**Architecture:** Add a pure server-side analyzer that validates API Format graphs and emits a canonical binding proposal with confidence and reasons. Expose it through an authenticated bounded upload route, let the existing workflow editor confirm the proposal, then persist the original graph plus the confirmed overlay through the existing immutable version service. Extend runtime validation to preserve optional graph defaults and reject media inputs that exceed the published workflow's confirmed capacity.

**Tech Stack:** Next.js App Router, TypeScript, React, Zod, Prisma JSON workflow versions, Vitest, next-intl.

---

### Task 1: API Format Detection and Canonical Analysis Contract

**Files:**
- Create: `src/lib/comfyui/workflow-auto-mapping-types.ts`
- Create: `src/lib/comfyui/workflow-auto-mapper.ts`
- Create: `tests/unit/comfyui/workflow-auto-mapper.test.ts`

- [ ] **Step 1: Write failing format and contract tests**

```ts
import { describe, expect, it } from 'vitest'
import { analyzeComfyApiWorkflow } from '@/lib/comfyui/workflow-auto-mapper'

const apiGraph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' }, _meta: { title: 'Positive Prompt' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  '3': { class_type: 'KSampler', inputs: { seed: 7 } },
}

describe('ComfyUI API workflow auto mapper', () => {
  it('rejects normal Workflow JSON with an API Format export diagnostic', () => {
    expect(() => analyzeComfyApiWorkflow({
      graph: { nodes: [], links: [] },
      kind: 'image_generation',
    })).toThrow('COMFY_WORKFLOW_API_FORMAT_REQUIRED')
  })

  it('returns immutable graph data and canonical proposal metadata', () => {
    const result = analyzeComfyApiWorkflow({ graph: apiGraph, kind: 'image_generation' })
    expect(result.graph).toEqual(apiGraph)
    expect(result.graph).not.toBe(apiGraph)
    expect(result.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: 'prompt', confidence: 'high' }),
    ]))
    expect(result.outputs).toEqual([
      expect.objectContaining({ nodeId: '2', mediaType: 'image', primary: true }),
    ])
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: FAIL because the analyzer modules do not exist.

- [ ] **Step 3: Define the canonical types and strict API graph parser**

```ts
import type {
  ComfyApiWorkflow, ComfyBindingTransform, ComfyMediaType, ComfyOutputBinding,
  ComfyVariableType, ComfyWorkflowPurpose, WorkflowValidationIssue,
} from './types'

export type WorkflowImportKind =
  | 'image_generation'
  | 'image_edit'
  | 'image_upscale'
  | 'video_generation'
  | 'video_to_video'

export const WORKFLOW_IMPORT_KIND_META: Record<WorkflowImportKind, {
  mediaType: ComfyMediaType
  purpose: ComfyWorkflowPurpose
  requiredInputs: readonly CanonicalWorkflowInput[]
}> = {
  image_generation: { mediaType: 'image', purpose: 'generation', requiredInputs: ['prompt'] },
  image_edit: { mediaType: 'image', purpose: 'generation', requiredInputs: ['prompt', 'sourceImage'] },
  image_upscale: { mediaType: 'image', purpose: 'upscale', requiredInputs: ['sourceImage'] },
  video_generation: { mediaType: 'video', purpose: 'generation', requiredInputs: ['prompt'] },
  video_to_video: { mediaType: 'video', purpose: 'generation', requiredInputs: ['prompt', 'sourceVideo'] },
}

export type CanonicalWorkflowInput =
  | 'prompt' | 'negativePrompt' | 'width' | 'height' | 'seed'
  | 'sourceImage' | 'referenceImages' | 'duration' | 'fps'
  | 'firstFrame' | 'lastFrame' | 'sourceVideo'

export type MappingConfidence = 'high' | 'ambiguous' | 'preserve_original' | 'blocking'

export interface WorkflowMappingProposal {
  id: string
  canonicalName: CanonicalWorkflowInput
  nodeId: string
  inputPath: string
  valueType: ComfyVariableType
  transform?: ComfyBindingTransform
  confidence: MappingConfidence
  reasonCode: string
  required: boolean
  referenceIndex?: number
  nodeTitle?: string
}

export interface WorkflowAutoMappingResult {
  graph: ComfyApiWorkflow
  mediaType: ComfyMediaType
  purpose: ComfyWorkflowPurpose
  proposals: WorkflowMappingProposal[]
  outputs: ComfyOutputBinding[]
  issues: WorkflowValidationIssue[]
  referenceCapacity: number
}
```

Implement `readApiFormatGraph` so every top-level value must contain a non-empty `class_type` and an object `inputs`. Reject `{ nodes, links }` and arrays with `COMFY_WORKFLOW_API_FORMAT_REQUIRED`. Deep-clone the accepted graph before returning it.

- [ ] **Step 4: Implement analyzer scaffolding and output recognition**

Recognize image outputs by `SaveImage`, `PreviewImage`, and class names containing `image` plus `save|output|preview`. Recognize video outputs by `VHS_VideoCombine` and class names containing `video` plus `save|combine|output`. Emit a single primary output automatically only when the selected kind has one unique candidate; emit `COMFY_WORKFLOW_OUTPUT_AMBIGUOUS` or `COMFY_WORKFLOW_OUTPUT_REQUIRED` issues otherwise.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: all format, cloning, and output tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/comfyui/workflow-auto-mapping-types.ts src/lib/comfyui/workflow-auto-mapper.ts tests/unit/comfyui/workflow-auto-mapper.test.ts
git commit -m "feat: analyze ComfyUI API workflow shape"
```

### Task 2: Scalar Canonical Parameter Inference

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `tests/unit/comfyui/workflow-auto-mapper.test.ts`

- [ ] **Step 1: Add failing scalar inference tests**

Add table-driven fixtures for positive prompt, negative prompt, width, height,
seed, duration, and FPS. Assert that model, LoRA, sampler, scheduler, steps, and
CFG inputs never appear in proposals.

```ts
function scalarGraph(title: string, inputName: string) {
  return {
    '1': { class_type: title.replaceAll(' ', ''), inputs: { [inputName]: inputName === 'text' ? 'value' : 1 }, _meta: { title } },
    '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
  }
}

it.each([
  ['Positive Prompt', 'text', 'prompt'],
  ['Negative Prompt', 'text', 'negativePrompt'],
  ['Empty Latent Image', 'width', 'width'],
  ['Empty Latent Image', 'height', 'height'],
  ['KSampler', 'seed', 'seed'],
  ['Video Settings', 'duration', 'duration'],
  ['Video Settings', 'fps', 'fps'],
])('maps %s.%s to %s', (title, inputName, canonicalName) => {
  const result = analyzeComfyApiWorkflow({ graph: scalarGraph(title, inputName), kind: 'video_generation' })
  expect(result.proposals).toContainEqual(expect.objectContaining({ canonicalName, confidence: 'high' }))
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts -t 'maps|never exposes'`

Expected: FAIL because scalar proposal rules are absent.

- [ ] **Step 3: Implement a deterministic scoring table**

Use normalized tokens from `class_type`, input name, and `_meta.title`. Require
positive evidence for every canonical field. Prompt polarity uses title and
downstream conditioning context; an unlabelled `text` input is ambiguous, not
silently positive. Only emit the canonical names defined by the design.

```ts
const SCALAR_RULES: readonly ScalarRule[] = [
  { canonicalName: 'width', inputNames: ['width'], valueType: 'number' },
  { canonicalName: 'height', inputNames: ['height'], valueType: 'number' },
  { canonicalName: 'seed', inputNames: ['seed', 'noise_seed'], valueType: 'number' },
  { canonicalName: 'duration', inputNames: ['duration', 'seconds'], valueType: 'number' },
  { canonicalName: 'fps', inputNames: ['fps', 'frame_rate'], valueType: 'number' },
]
```

- [ ] **Step 4: Verify canonical-only behavior**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: scalar mappings pass and non-project parameters remain absent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/comfyui/workflow-auto-mapper.ts tests/unit/comfyui/workflow-auto-mapper.test.ts
git commit -m "feat: infer canonical ComfyUI scalar inputs"
```

### Task 3: Multi-Media Role and Reference Capacity Inference

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `src/lib/comfyui/workflow-auto-mapping-types.ts`
- Modify: `src/lib/comfyui/types.ts`
- Modify: `tests/unit/comfyui/workflow-auto-mapper.test.ts`

- [ ] **Step 1: Add failing media-role tests**

Cover image-to-image source, first and last frames, source video, two ordered
reference inputs, ambiguous loaders, and no graph-topology mutation.

```ts
function multiReferenceGraph() {
  return {
    '2': { class_type: 'LoadImage', inputs: { image: 'style.png' }, _meta: { title: 'Style Reference 2' } },
    '1': { class_type: 'LoadImage', inputs: { image: 'character.png' }, _meta: { title: 'Character Reference 1' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
}

function ambiguousLoaderGraph() {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
  }
}

it('orders all existing reference inputs without inventing nodes', () => {
  const result = analyzeComfyApiWorkflow({ graph: multiReferenceGraph(), kind: 'image_edit' })
  expect(result.proposals.filter((row) => row.canonicalName === 'referenceImages'))
    .toMatchObject([{ referenceIndex: 0 }, { referenceIndex: 1 }])
  expect(result.referenceCapacity).toBe(2)
  expect(Object.keys(result.graph)).toEqual(Object.keys(multiReferenceGraph()))
})

it('requires confirmation for an unlabeled image loader', () => {
  const result = analyzeComfyApiWorkflow({ graph: ambiguousLoaderGraph(), kind: 'image_edit' })
  expect(result.proposals).toContainEqual(expect.objectContaining({
    valueType: 'image_ref', confidence: 'ambiguous',
  }))
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts -t 'reference|loader|frame|video'`

Expected: FAIL because media-role inference is absent.

- [ ] **Step 3: Implement existing-loader classification**

Classify only existing media input nodes. Use stable numeric-aware node ID
ordering as the final reference ordering tie-breaker. Emit `filename` for
single source/frame loader inputs, `filename_at` plus `referenceIndex` for
each scalar reference loader, and `filename_list` only when an existing input
itself accepts a bounded list. Recognize:

- `first|start` as `firstFrame`.
- `last|end` as `lastFrame`.
- `init|source|img2img` as `sourceImage`.
- `reference|ipadapter|controlnet|character|style` as `referenceImages`.
- video loader source roles as `sourceVideo`.

In `src/lib/comfyui/types.ts`, add `maxItems?: number` to
`ComfyVariableDefinition`, `valueIndex?: number` to `ComfyInputBinding`, and
`filename_at` to `ComfyBindingTransform`. These shared fields are introduced
here so Task 5's confirmation converter uses the same names as Task 6's
runtime validator. Do not insert, delete, clone, or reconnect any graph node.

- [ ] **Step 4: Verify media mapping and capacity**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: all media roles, ambiguity, ordering, and topology tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/comfyui/workflow-auto-mapper.ts src/lib/comfyui/workflow-auto-mapping-types.ts src/lib/comfyui/types.ts tests/unit/comfyui/workflow-auto-mapper.test.ts
git commit -m "feat: infer ComfyUI media slots safely"
```

### Task 4: Authenticated Bounded Analysis Route

**Files:**
- Create: `src/app/api/comfyui/workflows/analyze/route.ts`
- Modify: `src/lib/comfyui/workflow-route-schema.ts`
- Modify: `tests/contracts/route-catalog.ts`
- Modify: `tests/integration/api/contract/infra-routes.test.ts`
- Create: `tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts`

- [ ] **Step 1: Write failing route tests**

Test authentication before parsing, the 4 MB graph limit, API Format rejection,
successful analysis, and response exclusion of credentials and unbounded raw
errors.

```ts
it('analyzes an authenticated bounded API Format upload', async () => {
  installAuthMocks()
  mockAuthenticated('user-1')
  const route = await import('@/app/api/comfyui/workflows/analyze/route')
  const response = await route.POST(buildMockRequest({
    path: '/api/comfyui/workflows/analyze', method: 'POST', body: {
      kind: 'image_generation', apiFormatJson: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' }, _meta: { title: 'Positive Prompt' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
    },
  }), { params: Promise.resolve({}) })
  expect(response.status).toBe(200)
  expect(await responseJson(response)).toEqual(expect.objectContaining({
    analysis: expect.objectContaining({ mediaType: 'image', purpose: 'generation' }),
  }))
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts`

Expected: FAIL because the route is missing.

- [ ] **Step 3: Add the strict request schema and route**

```ts
export const analyzeWorkflowSchema = z.object({
  kind: z.enum(['image_generation', 'image_edit', 'image_upscale', 'video_generation', 'video_to_video']),
  apiFormatJson: z.union([
    z.string().max(4 * 1024 * 1024),
    z.record(z.string(), z.unknown()),
  ]),
}).strict()
```

The route must call `requireUserAuth` before `readBoundedJson`, parse strings
as JSON, call `assertBoundedWorkflowJson`, invoke
`analyzeComfyApiWorkflow`, and map stable analyzer codes to
`ApiError('INVALID_PARAMS', { reason: code })`. Detect normal Workflow JSON
before generic graph validation so the client can show the API Format export
instruction. Never include the uploaded graph, credentials, or raw exception
text in an error response.

- [ ] **Step 4: Update the route catalog and verify GREEN**

Add `src/app/api/comfyui/workflows/analyze/route.ts` to `ROUTE_FILES`. Add an
assertion to `infra-routes.test.ts` that the generated infra group contains
the analyze route; the dedicated route test remains responsible for POST
behavior.

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts tests/integration/api/contract/infra-routes.test.ts`

Expected: route and route-catalog tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/comfyui/workflows/analyze/route.ts src/lib/comfyui/workflow-route-schema.ts tests/contracts/route-catalog.ts tests/integration/api/contract/infra-routes.test.ts tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts
git commit -m "feat: analyze uploaded ComfyUI workflows"
```

### Task 5: Upload, Auto-Map, and Confirmation Wizard

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowUploadStep.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/hooks.ts`
- Modify: `messages/en/comfyui.json`
- Modify: `messages/zh/comfyui.json`
- Modify: `tests/unit/components/comfyui-workflow-settings.test.ts`

- [ ] **Step 1: Add failing UI and reducer tests**

Assert that new creation starts at upload, accepts only `.json`, calls the
analysis endpoint, renders green/yellow/gray/red states, requires confirmation
of ambiguous rows, and converts confirmed proposals to existing
`variableDefinitions`, `bindings`, and `outputs`.

```ts
it('converts confirmed proposals into the existing immutable overlay payload', () => {
  expect(confirmWorkflowAnalysis(analysisFixture(), confirmations())).toMatchObject({
    variableDefinitions: [expect.objectContaining({ name: 'prompt', type: 'string' })],
    bindings: [expect.objectContaining({ variable: 'prompt', nodeId: '1', inputPath: 'text' })],
    outputs: [expect.objectContaining({ nodeId: '9', primary: true })],
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/comfyui-workflow-settings.test.ts`

Expected: FAIL because upload wizard and confirmation conversion are absent.

- [ ] **Step 3: Implement workflow analysis client state**

Import the shared `WorkflowImportKind` and `WorkflowAutoMappingResult` types
from `@/lib/comfyui/workflow-auto-mapping-types`. Add
`WorkflowEditorStage = 'upload' | 'mapping' | 'validate'`, analysis result
state, confirmation selections, and `analyzeWorkflowUpload` in
`workflow-ui.ts`. Use the existing safe `WorkflowRequestError` mapping for
server failures; do not define a second client-only import-kind union.

- [ ] **Step 4: Build the upload and mapping components**

`WorkflowUploadStep` contains purpose/kind selection and file upload. New
creation no longer shows the raw JSON textarea or arbitrary add-variable
controls. `WorkflowAutoMappingTable` displays canonical name, node title/ID,
input path, required state, missing-value policy, confidence, and localized
reason. Ambiguous media rows use a select limited to compatible canonical
roles plus preserve-original. A missing primary output keeps the editor on the
mapping stage and blocks confirmation. Missing required canonical inputs may
be confirmed into an invalid draft, but the existing test and publish actions
remain disabled until its validation issues are resolved. When output analysis
finds multiple compatible candidates, render a required radio selection and
set exactly that output to `primary: true` in the confirmed overlay.

- [ ] **Step 5: Reuse the existing validation, save, test, and publish flow**

After confirmation, populate the existing `WorkflowAuthorDraft` with the
unmodified serialized graph and confirmed overlay. Existing version creation,
real connection testing, and publication remain authoritative. Editing an
existing version can show the confirmed overlay without forcing re-analysis;
uploading a replacement graph always starts a new analysis.

- [ ] **Step 6: Verify UI and locale guards**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/comfyui-workflow-settings.test.ts && npm run check:locale-navigation`

Expected: UI tests and locale checks pass.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/[locale]/profile/components/comfyui' messages/en/comfyui.json messages/zh/comfyui.json tests/unit/components/comfyui-workflow-settings.test.ts
git commit -m "feat: confirm automatic ComfyUI mappings"
```

### Task 6: Preserve Optional Defaults and Enforce Reference Capacity

**Files:**
- Modify: `src/lib/comfyui/workflow-schema.ts`
- Modify: `src/lib/comfyui/workflow-renderer.ts`
- Modify: `src/lib/comfyui/request-service.ts`
- Modify: `tests/unit/comfyui/workflow-compiler.test.ts`
- Modify: `tests/unit/comfyui/request-state-machine.test.ts`
- Modify: `tests/system/comfyui-generation.system.test.ts`

- [ ] **Step 1: Add failing runtime contract tests**

Test that absent optional media preserves the graph value, supplied references
replace confirmed slots in stable order, excess references fail before request
creation, and the failure occurs before task billing/submission.

```ts
it('blocks references beyond the published binding capacity', async () => {
  const create = vi.fn()
  const boundedVersion = {
    ...version,
    variableDefinitions: [{
      name: 'referenceImages', type: 'image_ref_list', required: false,
      missingValuePolicy: 'preserve_original', maxItems: 2,
    }],
  }
  const dependencies = {
    findInvocation: vi.fn().mockResolvedValue(null),
    findPublishedWorkflow: vi.fn().mockResolvedValue({
      id: 'workflow-1', mediaType: 'image', status: 'published',
      currentVersionId: boundedVersion.id, currentVersion: boundedVersion,
    }),
    create,
    resolveOwnedMedia: vi.fn(),
    transaction: async <T>(operation: (client: never) => Promise<T>) => operation(dependencies as never),
  }
  await expect(createComfyGenerationRequest({
    invocationKey: 'over-capacity', userId: 'user-1', projectId: 'project-1',
    taskId: 'task-1', mediaType: 'image', workflowId: 'workflow-1',
    variables: { referenceImages: [
      { storageKey: 'a' }, { storageKey: 'b' }, { storageKey: 'c' },
    ] },
  }, dependencies)).rejects.toMatchObject({
    code: 'INVALID_PARAMS',
    details: { reason: 'COMFY_REFERENCE_CAPACITY_EXCEEDED', maxItems: 2 },
  })
  expect(dependencies.resolveOwnedMedia).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-compiler.test.ts tests/unit/comfyui/request-state-machine.test.ts`

Expected: excess references are not yet rejected by the confirmed capacity.

- [ ] **Step 3: Implement overlay-capacity validation**

Finish runtime support for the Task 3 shared fields: `filename_at` is valid
only for an `image_ref_list`, requires a non-negative integer `valueIndex`, and
renders the matching uploaded filename into one existing scalar loader. The
Task 5 confirmation converter sets `referenceImages.maxItems` to the number of
confirmed existing reference slots and emits `filename_at` bindings in stable
index order.

Validate `maxItems` as an integer from 1 through the existing upload limit of
8 and reject it on non-list definitions. In `sanitizeVariableSnapshot`, reject
`image_ref_list` values longer than the saved definition's `maxItems` before
calling `resolveOwnedMedia` or `client.create`. Do not derive capacity from a
client-provided count. Throw `new ApiError('INVALID_PARAMS', {
reason: 'COMFY_REFERENCE_CAPACITY_EXCEEDED', maxItems })` so the caller can
show the saved maximum without leaking workflow data. Require every canonical
definition marked `required`.

- [ ] **Step 4: Preserve missing optional inputs**

Keep the current graph input unchanged when both definition and binding use
`missingValuePolicy: 'preserve_original'`. Never render missing optional media
as an empty string, empty filename, or empty list.

- [ ] **Step 5: Verify unit and system behavior**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/workflow-compiler.test.ts tests/unit/comfyui/request-state-machine.test.ts && SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/comfyui-generation.system.test.ts`

Expected: preservation, capacity, pinned-version, and system generation tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/comfyui/workflow-schema.ts src/lib/comfyui/workflow-renderer.ts src/lib/comfyui/request-service.ts tests/unit/comfyui/workflow-compiler.test.ts tests/unit/comfyui/request-state-machine.test.ts tests/system/comfyui-generation.system.test.ts
git commit -m "feat: enforce ComfyUI media binding capacity"
```

### Task 7: End-to-End Workflow Import Acceptance

**Files:**
- Modify: `tests/contracts/comfyui-acceptance-scenarios.ts`
- Create: `tests/integration/api/contract/comfyui-workflow-auto-mapping.test.ts`
- Modify: `tests/system/comfyui-generation.system.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-comfyui-api-workflow-auto-mapping-design.md`

- [ ] **Step 1: Add the acceptance matrix entries**

Register scenarios for API Format rejection, scalar mapping, img2img,
multi-reference image, first/last-frame video, video-to-video, ambiguous
confirmation, optional preservation, reference capacity, real test, publish,
and pinned execution.

- [ ] **Step 2: Write the end-to-end acceptance test**

Use the fake ComfyUI HTTP/WS server and production analyzer, workflow service,
test service, publisher, request service, compiler, client, and dispatcher.
Create a workflow from an uploaded API graph, confirm the proposal, test on an
owned connection, publish, execute with two references, and assert the fake
server receives the expected uploaded filenames at the confirmed nodes.

- [ ] **Step 3: Run the focused acceptance suite**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/integration/api/contract/comfyui-workflow-auto-mapping.test.ts && SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/comfyui-generation.system.test.ts`

Expected: all workflow import and runtime acceptance scenarios pass.

- [ ] **Step 4: Update the design acceptance checklist**

Append an implementation evidence section containing the focused test commands,
scenario IDs, and final commit hashes. Do not change the approved behavior.

- [ ] **Step 5: Run full verification**

Run: `npm run lint:all && npm run typecheck && npm run test:all && npm run build`

Expected: lint has zero errors, typecheck passes, all test suites pass, and the production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add tests/contracts/comfyui-acceptance-scenarios.ts tests/integration/api/contract/comfyui-workflow-auto-mapping.test.ts tests/system/comfyui-generation.system.test.ts docs/superpowers/specs/2026-07-13-comfyui-api-workflow-auto-mapping-design.md
git commit -m "test: verify ComfyUI workflow auto mapping"
```
