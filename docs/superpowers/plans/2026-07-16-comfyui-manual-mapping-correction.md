# ComfyUI Manual Mapping Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users repair a missing required prompt by changing an existing automatic mapping or selecting a compatible workflow field, without editing JSON or technical identifiers.

**Architecture:** Derive safe manual candidates from the already validated API graph, store selected candidates in wizard state, and combine them with analyzer proposals before review and contract confirmation. Keep the correction UI in the guided review stage and reuse the combined analysis so readiness and the saved contract cannot disagree.

**Tech Stack:** React 19, TypeScript, Next.js, next-intl, existing ComfyUI workflow contract helpers.

**Owner override:** Do not add or run automated tests. Validate only with TypeScript, affected-file ESLint, locale-key parity inspection, and `git diff --check`.

---

### Task 1: Safe manual mapping candidates and deterministic merge

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`

- [ ] **Step 1: Define the manual candidate contract**

Create `ManualWorkflowMapping` with `id`, `canonicalName`, `nodeId`, `inputPath`, `valueType`, and optional `nodeTitle`. Export `ManualWorkflowMappings = Partial<Record<CanonicalWorkflowInput, ManualWorkflowMapping>>`.

```ts
export interface ManualWorkflowMapping {
  id: string
  canonicalName: CanonicalWorkflowInput
  nodeId: string
  inputPath: string
  valueType: ComfyVariableType
  nodeTitle?: string
}

export type ManualWorkflowMappings = Partial<
  Record<CanonicalWorkflowInput, ManualWorkflowMapping>
>
```

- [ ] **Step 2: Derive compatible unbound scalar candidates**

Walk `analysis.graph` in stable node/input order. For `prompt` and `negativePrompt`, include only literal string inputs. Exclude arrays, objects, analyzer-proposed node/path pairs, and pairs selected by another manual mapping. Generate IDs from an encoded node/path tuple and return the current selection even while excluding other occupied pairs.

```ts
export function manualWorkflowMappingCandidates(
  analysis: WorkflowAutoMappingResult,
  canonicalName: CanonicalWorkflowInput,
  selected: ManualWorkflowMappings,
): ManualWorkflowMapping[]
```

- [ ] **Step 3: Merge only verified candidates into analysis**

Export `withManualWorkflowMappings(analysis, selected, roles)`. Re-derive candidates from `analysis.graph`, reject a selection not present in the candidate set, reject duplicate node/path pairs, and reject a manual canonical role already occupied by any effective analyzer mapping. Multiple analyzer proposals may legally fan out from the same canonical role. Append verified synthetic high-confidence proposals with reason code `COMFY_MAPPING_MANUAL`.

```ts
export function withManualWorkflowMappings(
  analysis: WorkflowAutoMappingResult,
  selected: ManualWorkflowMappings,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
): WorkflowAutoMappingResult
```

- [ ] **Step 4: Keep role overrides authoritative**

Update review and confirmation helpers only where necessary so an explicit role override on a high-confidence proposal wins over its analyzer default. Both readiness review and `confirmWorkflowAnalysis` must receive the same merged analysis object.

- [ ] **Step 5: Commit the contract layer**

```bash
git add 'src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts' \
  'src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts' \
  'src/app/[locale]/profile/components/comfyui/workflow-ui.ts'
HUSKY=0 git commit -m "feat: support verified manual workflow mappings"
```

### Task 2: Guided manual correction UI

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Add the missing-input correction component**

Render one labeled select for every missing required input and every active manual selection. Options show friendly `nodeTitle · inputPath`; technical text below the selection shows `nodeId.inputPath`. Include a blank option to clear the correction and a localized empty-candidate message.

```tsx
<WorkflowManualMappingCorrections
  analysis={analysis}
  missingRequiredInputs={review.missingRequiredInputs}
  value={manualMappings}
  disabled={busy === 'creating' || completed}
  onChange={setManualMappings}
/>
```

- [ ] **Step 2: Unlock type-compatible automatic mappings**

In `WorkflowAutoMappingTable`, remove the `confidence !== 'ambiguous'` disable condition. Keep the whole select disabled only while the wizard is creating or completed. Continue using `guidedCompatibleRoles(proposal)` so incompatible role changes are not offered.

```tsx
<select
  disabled={disabled}
  value={selected}
  onChange={(event) => onRoleChange(proposal.id, event.target.value as WorkflowRole)}
>
```

- [ ] **Step 3: Integrate manual state into the wizard**

Add `manualMappings` state, reset it in `clearGraphState` and before every replacement analysis, derive `effectiveAnalysis = withManualWorkflowMappings(analysis, manualMappings, roles)`, and use that object for `buildGuidedWorkflowReview` and `confirmWorkflowAnalysis`. Pass the selected import kind's required inputs to confirmation so role overrides recompute required status from the final canonical role; fan-out bindings for one canonical role must share one definition and missing-value policy. Render corrections before the mapping questions so the recovery control is visible without opening advanced settings.

- [ ] **Step 4: Add English and Chinese copy**

Add matching locale keys for the correction heading, field label, placeholder, candidate-empty explanation, clear option, and technical selected-field hint. Keep the key sets identical.

- [ ] **Step 5: Commit the guided UI**

```bash
git add 'src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx' \
  messages/zh/comfyui.json messages/en/comfyui.json
HUSKY=0 git commit -m "feat: add guided workflow mapping correction"
```

### Task 3: Focused static validation and GitHub update

**Files:**
- Inspect: all files changed by Tasks 1 and 2

- [ ] **Step 1: Run TypeScript validation**

```bash
npm run typecheck
```

Expected: exit code `0`.

- [ ] **Step 2: Run affected-file lint only**

```bash
npx eslint \
  'src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts' \
  'src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx' \
  'src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts' \
  'src/app/[locale]/profile/components/comfyui/workflow-ui.ts'
```

Expected: exit code `0`.

- [ ] **Step 3: Inspect locale parity and whitespace**

```bash
node -e "const fs=require('fs');const z=JSON.parse(fs.readFileSync('messages/zh/comfyui.json'));const e=JSON.parse(fs.readFileSync('messages/en/comfyui.json'));const a=Object.keys(z.workflows.guided).sort();const b=Object.keys(e.workflows.guided).sort();if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1)"
git diff --check
git status --short
```

Expected: locale keys match, diff check exits `0`, and only intentional changes are present.

- [ ] **Step 4: Push the existing feature branch**

```bash
git push --no-verify duanju feat/comfyui-guided-workflow-creation
git fetch duanju feat/comfyui-guided-workflow-creation
test "$(git rev-parse HEAD)" = "$(git rev-parse duanju/feat/comfyui-guided-workflow-creation)"
```

Expected: local and remote commit IDs match.
