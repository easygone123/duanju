# ComfyUI Duration and Frame Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert canonical fractional seconds into the exact seconds or total-frame scalar required by each ComfyUI video workflow, with explicit FPS, rounding, first-frame offset, encoding, and allowed-value validation.

**Architecture:** Keep `duration` and `fps` as canonical numbers. Persist a typed numeric transform on `ComfyInputBinding`, execute it in one pure converter shared by rendering and capability resolution, and carry it through analysis, guided/manual authoring, immutable versions, testing, and dispatch. Bindings without the new field remain identity mappings.

**Tech Stack:** TypeScript, React, Next.js, next-intl, Vitest, Prisma/MySQL, existing ComfyUI compiler and dispatcher.

---

## File Map

- Create `src/lib/comfyui/numeric-binding.ts`: pure conversion and decimal-safe validation.
- Modify `src/lib/comfyui/types.ts`: transform and diagnostic contracts.
- Modify `src/lib/comfyui/workflow-schema.ts` and `workflow-renderer.ts`: validation and rendering.
- Modify auto-mapping and guided-mapping files: inference, manual candidates, confirmation.
- Create `WorkflowNumericTransformEditor.tsx`: shared guided/saved editor with preview.
- Create `src/lib/comfyui/duration-contract.ts`: convert native allowed values back to canonical seconds.
- Modify server video submission: validate against the pinned binding contract.
- Modify Prisma request persistence and dispatcher: store effective conversion diagnostics.

### Task 1: Typed Numeric Conversion Core

**Files:**
- Create: `src/lib/comfyui/numeric-binding.ts`
- Modify: `src/lib/comfyui/types.ts`
- Test: `tests/unit/comfyui/numeric-binding.test.ts`

- [ ] **Step 1: Write failing conversion tests**

```ts
import { describe, expect, it } from 'vitest'
import { convertComfyNumericBinding } from '@/lib/comfyui/numeric-binding'
import type { ComfyNumericBindingTransform } from '@/lib/comfyui/types'

const frames = (patch: Partial<ComfyNumericBindingTransform> = {}): ComfyNumericBindingTransform => ({
  sourceUnit: 'seconds',
  targetUnit: 'frames',
  output: 'number',
  fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
  rounding: 'round',
  frameOffset: 1,
  ...patch,
})

describe('ComfyUI numeric bindings', () => {
  it('preserves fractional seconds', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration',
      value: 5.5,
      variables: {},
      transform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' },
    }).targetValue).toBe(5.5)
  })

  it('uses runtime FPS before fallback', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration', value: 5, variables: { fps: 24 }, transform: frames(),
    })).toMatchObject({ targetValue: 121, effectiveFps: 24 })
  })

  it('uses fallback FPS and emits a numeric string', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration', value: 5, variables: {},
      transform: frames({ output: 'numeric_string' }),
    }).encodedValue).toBe('81')
  })

  it.each([['round', 53], ['floor', 52], ['ceil', 53]] as const)(
    'applies %s deterministically', (rounding, expected) => {
      expect(convertComfyNumericBinding({
        variable: 'duration', value: 3.3, variables: {},
        transform: frames({ rounding, frameOffset: 0 }),
      }).targetValue).toBe(expected)
    },
  )

  it('rejects unsupported target values without snapping', () => {
    expect(() => convertComfyNumericBinding({
      variable: 'duration', value: 6, variables: {},
      transform: frames({ allowedTargetValues: [81, 161] }),
    })).toThrowError(/unsupported_target/)
  })
})
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/comfyui/numeric-binding.test.ts
```

Expected: FAIL because the module and transform type do not exist.

- [ ] **Step 3: Add persisted types**

Add to `src/lib/comfyui/types.ts`:

```ts
export type ComfyNumericUnit = 'seconds' | 'frames' | 'fps'
export type ComfyNumericOutput = 'number' | 'numeric_string'
export type ComfyNumericRounding = 'round' | 'floor' | 'ceil'

export interface ComfyNumericBindingTransform {
  sourceUnit: 'seconds' | 'fps'
  targetUnit: ComfyNumericUnit
  output: ComfyNumericOutput
  fps?: { source: 'runtime_then_fallback'; variable: 'fps'; fallback: number }
  rounding?: ComfyNumericRounding
  frameOffset?: 0 | 1
  allowedTargetValues?: number[]
}

export interface ComfyNumericConversionDiagnostic {
  variable: string
  sourceValue: number
  targetValue: number
  encodedAs: ComfyNumericOutput
  sourceUnit: 'seconds' | 'fps'
  targetUnit: ComfyNumericUnit
  effectiveFps?: number
  rounding?: ComfyNumericRounding
  frameOffset?: 0 | 1
}
```

Add `numericTransform?: ComfyNumericBindingTransform` to `ComfyInputBinding` and `onNumericConversion?(diagnostic: ComfyNumericConversionDiagnostic): void` to `RenderWorkflowInput`.

- [ ] **Step 4: Implement the converter**

Create `src/lib/comfyui/numeric-binding.ts`:

```ts
import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyNumericBindingTransform,
  ComfyNumericConversionDiagnostic,
  ComfyVariableValue,
} from './types'

function invalid(variable: string, reason: string): never {
  throw new ComfyError(
    COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
    `Invalid numeric workflow binding: ${reason}`,
    { details: { variable, reason } },
  )
}

export function decimalEquals(left: number, right: number) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Number.EPSILON * scale * 8
}

export function convertComfyNumericBinding(input: {
  variable: string
  value: unknown
  variables: Record<string, ComfyVariableValue | undefined>
  transform: ComfyNumericBindingTransform
}): ComfyNumericConversionDiagnostic & { encodedValue: number | string } {
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value <= 0) {
    invalid(input.variable, 'invalid_source')
  }
  const sourceValue = input.value as number
  let targetValue = sourceValue
  let effectiveFps: number | undefined
  if (input.transform.sourceUnit === 'seconds' && input.transform.targetUnit === 'frames') {
    const runtime = input.variables[input.transform.fps?.variable ?? 'fps']
    effectiveFps = typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0
      ? runtime
      : input.transform.fps?.fallback
    if (!effectiveFps || !Number.isFinite(effectiveFps) || effectiveFps <= 0) {
      invalid(input.variable, 'missing_fps')
    }
    const applyRounding = input.transform.rounding === 'floor'
      ? Math.floor
      : input.transform.rounding === 'ceil' ? Math.ceil : Math.round
    targetValue = applyRounding(sourceValue * effectiveFps) + (input.transform.frameOffset ?? 0)
    if (!Number.isSafeInteger(targetValue) || targetValue <= 0) {
      invalid(input.variable, 'invalid_frames')
    }
  }
  if (input.transform.allowedTargetValues?.length
    && !input.transform.allowedTargetValues.some((allowed) => decimalEquals(allowed, targetValue))) {
    invalid(input.variable, 'unsupported_target')
  }
  return {
    variable: input.variable,
    sourceValue,
    targetValue,
    encodedValue: input.transform.output === 'numeric_string' ? String(targetValue) : targetValue,
    encodedAs: input.transform.output,
    sourceUnit: input.transform.sourceUnit,
    targetUnit: input.transform.targetUnit,
    ...(effectiveFps === undefined ? {} : { effectiveFps }),
    ...(input.transform.rounding === undefined ? {} : { rounding: input.transform.rounding }),
    ...(input.transform.frameOffset === undefined ? {} : { frameOffset: input.transform.frameOffset }),
  }
}
```

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx vitest run tests/unit/comfyui/numeric-binding.test.ts
npm run typecheck
git add src/lib/comfyui/types.ts src/lib/comfyui/numeric-binding.ts tests/unit/comfyui/numeric-binding.test.ts
git commit -m "feat: add ComfyUI numeric binding transforms"
```

Expected: focused tests and typecheck pass.

### Task 2: Schema and Renderer Integration

**Files:**
- Modify: `src/lib/comfyui/workflow-schema.ts`
- Modify: `src/lib/comfyui/workflow-renderer.ts`
- Test: `tests/unit/comfyui/workflow-compiler.test.ts`
- Test: `tests/integration/api/contract/comfyui-workflows-route.test.ts`

- [ ] **Step 1: Add failing renderer and schema cases**

```ts
it('renders seconds into inclusive total frames', () => {
  const diagnostics: unknown[] = []
  const rendered = renderComfyWorkflow({
    graph: { '1': { class_type: 'VideoNode', inputs: { length: 81 } } },
    variableDefinitions: [
      { name: 'duration', type: 'number', required: true },
      { name: 'fps', type: 'number', required: false, defaultValue: 16 },
    ],
    bindings: [{
      nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
      numericTransform: {
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
        rounding: 'round', frameOffset: 1,
      },
    }],
    variables: { duration: 5 },
    uploads: {},
    onNumericConversion: (item) => diagnostics.push(item),
  })
  expect(rendered['1'].inputs.length).toBe(81)
  expect(diagnostics).toEqual([expect.objectContaining({ targetValue: 81 })])
})

it('rejects frames configuration without fallback FPS', () => {
  const issues = validateWorkflowContract({
    graph: { '1': { class_type: 'VideoNode', inputs: { length: 81 } } },
    variableDefinitions: [
      { name: 'duration', type: 'number', required: true },
      { name: 'fps', type: 'number', required: false, defaultValue: 16 },
    ],
    bindings: [{
      nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
      numericTransform: {
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        rounding: 'round', frameOffset: 1,
      },
    }],
    outputs: [{
      name: 'primary', nodeId: '1', fieldPath: 'images',
      mediaType: 'video', primary: true,
    }],
  })
  expect(issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'COMFY_BINDING_NUMERIC_TRANSFORM_INVALID' }),
  ]))
})
```

Extend the workflow-route contract test with two otherwise identical version
payloads whose only difference is `numericTransform`; assert that they produce
different content hashes and are stored as separate immutable versions.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/comfyui/workflow-compiler.test.ts
```

Expected: FAIL because schema and renderer do not process the transform.

- [ ] **Step 3: Validate the full transform shape**

In `workflow-schema.ts`, implement `validateNumericTransform`. Require `valueType === 'number'`, valid source/target pairs, number/string output, finite unique positive allowed values, and these frame fields:

```ts
const validFrames = targetUnit !== 'frames' || (
  isObject(value.fps)
  && value.fps.source === 'runtime_then_fallback'
  && value.fps.variable === 'fps'
  && isPositiveFinite(value.fps.fallback)
  && ['round', 'floor', 'ceil'].includes(String(value.rounding))
  && (value.frameOffset === 0 || value.frameOffset === 1)
)
```

Only `seconds -> seconds`, `seconds -> frames`, and `fps -> fps` are valid. Non-frame targets must not carry FPS, rounding, or offset. Emit `COMFY_BINDING_NUMERIC_TRANSFORM_INVALID` at `bindings.<index>.numericTransform`.

- [ ] **Step 4: Apply conversion once in the renderer**

Before media transforms in `transformBindingValue`:

```ts
if (binding.numericTransform) {
  const converted = convertComfyNumericBinding({
    variable: binding.variable,
    value,
    variables,
    transform: binding.numericTransform,
  })
  onNumericConversion?.(converted)
  return converted.encodedValue
}
```

Pass resolved variables and callback into the helper. Preserve graph and variable cloning.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/workflow-compiler.test.ts tests/unit/comfyui/numeric-binding.test.ts tests/integration/api/contract/comfyui-workflows-route.test.ts
npm run typecheck
git add src/lib/comfyui/workflow-schema.ts src/lib/comfyui/workflow-renderer.ts tests/unit/comfyui/workflow-compiler.test.ts tests/integration/api/contract/comfyui-workflows-route.test.ts
git commit -m "feat: render ComfyUI duration units safely"
```

Expected: both suites and typecheck pass.

### Task 3: Analyzer, Manual Candidates, and Contract Confirmation

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapping-types.ts`
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Test: `tests/unit/comfyui/workflow-auto-mapper.test.ts`
- Test: `tests/unit/components/comfyui-guided-mapping-draft.test.ts`
- Test: `tests/unit/comfyui/guided-workflow-creation.test.ts`

- [ ] **Step 1: Write failing inference cases**

```ts
it.each([
  ['duration_seconds', 5.5, 'seconds', 'number'],
  ['num_frames', 81, 'frames', 'number'],
  ['frame_count', '81', 'frames', 'numeric_string'],
] as const)('proposes duration semantics for %s', (inputPath, value, targetUnit, output) => {
  const result = analyzeComfyApiWorkflow({
    kind: 'video_generation',
    graph: {
      video: { class_type: 'VideoLengthNode', inputs: { [inputPath]: value } },
      prompt: { class_type: 'CLIPTextEncode', inputs: { text: 'move' } },
      out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
    },
  })
  expect(result.proposals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      nodeId: 'video',
      inputPath,
      canonicalName: 'duration',
      numericTransform: expect.objectContaining({ targetUnit, output }),
    }),
  ]))
})

it('does not infer an unrelated length field', () => {
  const result = analyzeComfyApiWorkflow({
    kind: 'video_generation',
    graph: {
      text: { class_type: 'StringUtility', inputs: { length: 81 } },
      out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
    },
  })
  expect(result.proposals.some((item) => item.nodeId === 'text' && item.canonicalName === 'duration')).toBe(false)
})
```

Add a draft test that maps numeric-string `length` to duration, chooses frames/FPS 16/round/+1, and expects `effectiveGuidedAnalysis` to retain the transform.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts tests/unit/components/comfyui-guided-mapping-draft.test.ts tests/unit/comfyui/guided-workflow-creation.test.ts
```

Expected: FAIL because proposals and candidates lack numeric metadata.

- [ ] **Step 3: Add deterministic inference**

Add `numericTransform?: ComfyNumericBindingTransform` to `WorkflowMappingProposal`. Normalize names into:

```ts
const SECOND_INPUTS = new Set(['duration', 'seconds', 'durationseconds', 'durations'])
const FRAME_INPUTS = new Set(['numframes', 'framecount', 'totalframes', 'videolength'])
const AMBIGUOUS_DURATION_INPUTS = new Set(['length', 'frames'])
```

Accept finite numbers and trimmed numeric strings. Require a video import kind plus video-related class/title evidence for high-confidence frame inference. Numeric strings use `numeric_string`; native numbers use `number`. `length` and `frames` stay confirmable.

- [ ] **Step 4: Make manual scalar candidates safe**

Add `numericTransformByRole` to `GuidedInputCandidate`. In video imports, finite numeric and numeric-string scalars can choose duration or FPS. Add:

```ts
export function updateGuidedNumericTransform(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
  numericTransform: ComfyNumericBindingTransform,
): GuidedWorkflowMappingDraft
```

Changing away from duration/FPS removes incompatible settings. Choosing duration installs a seconds identity transform whose output matches the literal representation.

- [ ] **Step 5: Compile into immutable contracts**

Copy `proposal.numericTransform` into `ComfyInputBinding`. For frame mappings, add an auxiliary FPS definition when missing:

```ts
definitions.set('fps', definitions.get('fps') ?? {
  name: 'fps',
  type: 'number',
  required: false,
  defaultValue: proposal.numericTransform.fps!.fallback,
})
```

Do not store native frames in canonical `duration.options`.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts tests/unit/components/comfyui-guided-mapping-draft.test.ts tests/unit/comfyui/guided-workflow-creation.test.ts
npm run typecheck
git add src/lib/comfyui/workflow-auto-mapping-types.ts src/lib/comfyui/workflow-auto-mapper.ts 'src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts' 'src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts' 'src/app/[locale]/profile/components/comfyui/workflow-ui.ts' tests/unit/comfyui/workflow-auto-mapper.test.ts tests/unit/components/comfyui-guided-mapping-draft.test.ts tests/unit/comfyui/guided-workflow-creation.test.ts
git commit -m "feat: map ComfyUI duration scalar variants"
```

Expected: focused tests and typecheck pass.

### Task 4: Guided and Saved Conversion Editor

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowNumericTransformEditor.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`
- Modify: `messages/en/comfyui.json`
- Modify: `messages/zh/comfyui.json`
- Test: `tests/unit/components/comfyui-numeric-transform-editor.test.tsx`
- Test: `tests/unit/components/comfyui-guided-workflow-creation.test.tsx`
- Test: `tests/unit/components/comfyui-workflow-mapping-table.test.tsx`
- Test: `tests/unit/components/comfyui-workflow-activation.test.tsx`
- Test: `tests/unit/components/comfyui-workflow-library-actions.test.tsx`

- [ ] **Step 1: Write failing component cases**

```tsx
it('configures frames and previews 81', () => {
  const onChange = vi.fn()
  const view = render(withMessages(<WorkflowNumericTransformEditor
    value={{ sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' }}
    sampleDuration={5}
    sampleFps={16}
    onChange={onChange}
  />))
  fireEvent.change(view.getByLabelText('Target unit'), { target: { value: 'frames' } })
  fireEvent.change(view.getByLabelText('Fallback FPS'), { target: { value: '16' } })
  fireEvent.change(view.getByLabelText('First-frame offset'), { target: { value: '1' } })
  expect(view.getByText(/5.*16.*1.*81/)).toBeTruthy()
})

it('previews fractional numeric-string seconds', () => {
  const view = render(withMessages(<WorkflowNumericTransformEditor
    value={{ sourceUnit: 'seconds', targetUnit: 'seconds', output: 'numeric_string' }}
    sampleDuration={5.5}
    sampleFps={24}
    onChange={() => undefined}
  />))
  expect(view.getByText(/"5.5"/)).toBeTruthy()
})
```

Add guided and saved-table tests proving duration rows render the editor and prompt rows do not.
Extend activation/library tests so a failed live test opens the same numeric
mapping in the author draft, preserves its conversion values, saves the
correction through `/versions`, and selects the returned immutable version.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/components/comfyui-numeric-transform-editor.test.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx tests/unit/components/comfyui-workflow-mapping-table.test.tsx
```

Expected: FAIL because the editor and messages do not exist.

- [ ] **Step 3: Build the controlled editor**

Give the editor an explicit `sourceUnit`/role prop. Duration rows render
seconds/frames, number/numeric-string, and comma-separated allowed values.
Frames mode additionally renders positive fallback FPS, rounding, and `0/1`
offset. FPS rows lock the unit pair to `fps -> fps` and expose only output
encoding and allowed values:

```tsx
<select
  aria-label={t('numeric.targetUnit')}
  value={value.targetUnit}
  onChange={(event) => onTargetUnitChange(event.target.value as 'seconds' | 'frames')}
>
  <option value="seconds">{t('numeric.seconds')}</option>
  <option value="frames">{t('numeric.frames')}</option>
</select>
```

Keep invalid allowed-value text visible and expose a blocking issue. Use `convertComfyNumericBinding` for preview.

- [ ] **Step 4: Wire both authoring surfaces**

Guided rows call `updateGuidedNumericTransform`. Saved rows show the editor for
number-backed `duration` and `fps` bindings. Changing away from duration/FPS
removes `numericTransform`; choosing either role installs the matching identity
transform when absent. Extend `GuidedMappingDraftIssue` with
`numericTransformInvalid` so incomplete or invalid editor text blocks creation
without discarding the user's text.

- [ ] **Step 5: Add English/Chinese locale parity**

Add these keys under the same `numeric` namespace in both ComfyUI locale files:

```json
{
  "targetUnit": "Target unit",
  "seconds": "Seconds",
  "frames": "Total frames",
  "outputFormat": "Output format",
  "number": "Number",
  "numericString": "Numeric string",
  "fallbackFps": "Fallback FPS",
  "rounding": "Rounding",
  "frameOffset": "First-frame offset",
  "allowedValues": "Allowed target values",
  "preview": "Conversion preview"
}
```

Use idiomatic Chinese translations.

Also add localized safe messages for `invalid_source`, `missing_fps`,
`invalid_frames`, and `unsupported_target`. The UI may show the field, source
value, effective FPS, and allowed target values, but never the full graph.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-numeric-transform-editor.test.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx tests/unit/components/comfyui-workflow-mapping-table.test.tsx tests/unit/components/comfyui-workflow-activation.test.tsx tests/unit/components/comfyui-workflow-library-actions.test.tsx
npm run check:locale-navigation
npm run typecheck
git add 'src/app/[locale]/profile/components/comfyui/WorkflowNumericTransformEditor.tsx' 'src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx' 'src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx' 'src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts' messages/en/comfyui.json messages/zh/comfyui.json tests/unit/components/comfyui-numeric-transform-editor.test.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx tests/unit/components/comfyui-workflow-mapping-table.test.tsx tests/unit/components/comfyui-workflow-activation.test.tsx tests/unit/components/comfyui-workflow-library-actions.test.tsx
git commit -m "feat: edit ComfyUI duration conversion settings"
```

Expected: component tests, locale guard, and typecheck pass.

### Task 5: Canonical Duration Choices

**Files:**
- Create: `src/lib/comfyui/duration-contract.ts`
- Modify: `src/lib/novel-promotion/video/server-panel-video-submission.ts`
- Test: `tests/unit/comfyui/duration-contract.test.ts`
- Test: `tests/unit/comfyui/generate-video-route.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
it('inverts allowed frames into canonical seconds', () => {
  expect(resolveComfyDurationContract({
    variableDefinitions: [{ name: 'duration', type: 'number', required: true }],
    bindings: [{
      nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
      numericTransform: {
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
        rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
      },
    }],
  })).toEqual({ kind: 'fixed', options: [5, 10] })
})

it('preserves fractional second options', () => {
  expect(resolveComfyDurationContract({
    variableDefinitions: [{ name: 'duration', type: 'number', required: true }],
    bindings: [{
      nodeId: '1', inputPath: 'seconds', variable: 'duration', valueType: 'number',
      numericTransform: {
        sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
        allowedTargetValues: [2.5, 5.5],
      },
    }],
  })).toEqual({ kind: 'fixed', options: [2.5, 5.5] })
})
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/comfyui/duration-contract.test.ts tests/unit/comfyui/generate-video-route.test.ts
```

Expected: FAIL because the resolver does not exist and server code reads definitions only.

- [ ] **Step 3: Implement native-to-canonical inversion**

For each allowed frame:

```ts
const seconds = (allowedFrame - frameOffset) / effectiveFps
```

Forward-check it with `convertComfyNumericBinding` and keep it only when it returns the original frame. Prefer positive runtime FPS, otherwise fallback. Sort and deduplicate. Seconds targets return allowed seconds unchanged. Legacy `duration.options` remains fallback.

- [ ] **Step 4: Use pinned binding data before submission**

Select `bindingSpec` with `variableDefinitions` and call:

```ts
const duration = resolveComfyDurationContract({
  variableDefinitions: comfyVersion.variableDefinitions,
  bindings: comfyVersion.bindingSpec,
  runtimeFps: positiveNumber(runtimeSelections.fps) ? runtimeSelections.fps : undefined,
})
```

Keep non-Comfy providers unchanged. Reject unsupported duration before task submission, billing, or capacity acquisition.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/duration-contract.test.ts tests/unit/comfyui/generate-video-route.test.ts
npm run typecheck
git add src/lib/comfyui/duration-contract.ts src/lib/novel-promotion/video/server-panel-video-submission.ts tests/unit/comfyui/duration-contract.test.ts tests/unit/comfyui/generate-video-route.test.ts
git commit -m "fix: resolve ComfyUI duration choices by unit"
```

Expected: frame, fractional seconds, and legacy provider cases pass.

### Task 6: Persist Conversion Diagnostics

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260718190000_add_comfy_numeric_diagnostics/migration.sql`
- Modify: `src/lib/comfyui/dispatcher.ts`
- Modify: `src/lib/comfyui/runtime-execution-adapter.ts`
- Test: `tests/integration/provider/comfyui-dispatcher.contract.test.ts`
- Test: `tests/unit/comfyui/runtime.test.ts`

- [ ] **Step 1: Write the failing ownership-safe test**

```ts
function frameDurationContext() {
  return context({
    request: {
      ...context().request,
      variableSnapshot: { duration: 5 },
    },
    version: {
      ...context().version,
      graph: {
        '1': { class_type: 'VideoNode', inputs: { length: 81 } },
        '2': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
      },
      variableDefinitions: [
        { name: 'duration', type: 'number' as const, required: true },
        { name: 'fps', type: 'number' as const, required: false, defaultValue: 16 },
      ],
      bindings: [{
        nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number' as const,
        numericTransform: {
          sourceUnit: 'seconds' as const, targetUnit: 'frames' as const, output: 'number' as const,
          fps: { source: 'runtime_then_fallback' as const, variable: 'fps' as const, fallback: 16 },
          rounding: 'round' as const, frameOffset: 1 as const,
        },
      }],
      outputs: [{
        name: 'primary', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true,
      }],
    },
  })
}

it('persists duration conversion before prompt submission', async () => {
  const recordNumericDiagnostics = vi.fn().mockResolvedValue(true)
  const deps = dependencies({
    loadContext: vi.fn().mockResolvedValue(frameDurationContext()),
    recordNumericDiagnostics,
  })
  await dispatchComfyRequest('request-1', deps)
  expect(recordNumericDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: 'request-1' }),
    [expect.objectContaining({
      variable: 'duration', sourceValue: 5, effectiveFps: 16, targetValue: 81,
    })],
  )
  const persistOrder = recordNumericDiagnostics.mock.invocationCallOrder[0]!
  const submitOrder = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
  expect(persistOrder).toBeLessThan(submitOrder)
})
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/integration/provider/comfyui-dispatcher.contract.test.ts tests/unit/comfyui/runtime.test.ts
```

Expected: FAIL because dispatcher dependencies cannot persist diagnostics.

- [ ] **Step 3: Add the nullable column and migration**

Add to `ComfyGenerationRequest`:

```prisma
numericDiagnostics Json?
```

Migration:

```sql
ALTER TABLE `comfy_generation_requests`
  ADD COLUMN `numericDiagnostics` JSON NULL;
```

Run `npx prisma generate`.

- [ ] **Step 4: Capture and persist before submit**

```ts
const numericDiagnostics: ComfyNumericConversionDiagnostic[] = []
const graph = renderComfyWorkflow({
  ...renderInput,
  onNumericConversion: (diagnostic) => numericDiagnostics.push(diagnostic),
})
if (numericDiagnostics.length > 0) {
  await mustOwn(dependencies.recordNumericDiagnostics(owner, numericDiagnostics))
}
```

Implement the production dependency as owner-scoped `updateMany` using request, user, project, lease, and active status. Return false on ownership loss. Never mix diagnostics into `variableSnapshot`.

- [ ] **Step 5: Verify and commit**

```bash
npx prisma validate
npx prisma generate
npx vitest run tests/integration/provider/comfyui-dispatcher.contract.test.ts tests/unit/comfyui/runtime.test.ts
npm run typecheck
git add prisma/schema.prisma prisma/migrations/20260718190000_add_comfy_numeric_diagnostics/migration.sql src/lib/comfyui/dispatcher.ts src/lib/comfyui/runtime-execution-adapter.ts tests/integration/provider/comfyui-dispatcher.contract.test.ts tests/unit/comfyui/runtime.test.ts
git commit -m "feat: record ComfyUI numeric conversion diagnostics"
```

Expected: Prisma, focused tests, and typecheck pass; lease loss prevents submit.

### Task 7: End-to-End Verification

**Files:**
- Modify only if verification exposes a defect in files already named above.

- [ ] **Step 1: Run the focused ComfyUI surface**

```bash
npx vitest run tests/unit/comfyui tests/unit/components/comfyui-*.test.ts tests/unit/components/comfyui-*.test.tsx tests/integration/provider/comfyui-*.test.ts tests/unit/comfyui/generate-video-route.test.ts
```

Expected: zero failed tests.

- [ ] **Step 2: Validate Prisma, lint, types, and whitespace**

```bash
npx prisma validate
npx prisma generate
npx eslint src/lib/comfyui src/lib/novel-promotion/video/server-panel-video-submission.ts 'src/app/[locale]/profile/components/comfyui' tests/unit/comfyui tests/integration/provider/comfyui-dispatcher.contract.test.ts
npm run typecheck
git diff --check
```

Expected: Prisma valid, ESLint zero errors, typecheck exit 0, silent diff check.

- [ ] **Step 3: Run the repository commit gate**

```bash
npm run verify:commit
```

Expected: lint, types, guards, unit, billing, integration, system, and regression suites exit 0.

- [ ] **Step 4: Run production build**

```bash
npm run build
```

Expected: Next.js build exits 0; warning-only output is acceptable.

- [ ] **Step 5: Audit final scope**

```bash
git status --short
git diff --check
git log --oneline --decorate -10
```

Expected: no uncommitted task files; unrelated user-owned files remain untouched.

If verification required a correction, stage only named task files and commit:

```bash
git add src/lib/comfyui src/lib/novel-promotion/video/server-panel-video-submission.ts 'src/app/[locale]/profile/components/comfyui' messages/en/comfyui.json messages/zh/comfyui.json prisma/schema.prisma prisma/migrations tests/unit/comfyui tests/unit/components tests/integration/provider
git commit -m "test: harden ComfyUI duration conversion"
```

## Completion Checklist

- Canonical duration remains fractional seconds.
- Seconds and frames render as numbers or numeric strings.
- Runtime FPS overrides required fallback FPS.
- Rounding and `+0/+1` are explicit and previewed.
- Fixed native values reject unsupported duration before submission.
- Numeric and numeric-string fields are manually mappable.
- Guided and saved mappings remain editable after test failure.
- Legacy bindings retain identity behavior.
- Effective diagnostics persist separately from canonical variables.
- Focused tests, full gate, and build pass.
