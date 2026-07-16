# BerniniStudio Dynamic Reference Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a published BerniniStudio ComfyUI workflow to receive zero through eight ordered reference images without padding, by injecting `LoadImage` nodes and wiring `image0` through `image7` at render time.

**Architecture:** Keep Bernini support allowlisted and explicit. The workflow analyzer emits one canonical `referenceImages` proposal with a Bernini-only binding transform; the renderer removes the uploaded workflow's stale Bernini image sockets, creates deterministic collision-free `LoadImage` nodes for actual uploads, and links only the occupied slots. Runtime input aliasing preserves legacy `input_images` workflows while routing guided workflows to `referenceImages`.

**Tech Stack:** TypeScript, Next.js, Vitest, ComfyUI API-format workflow JSON.

---

### Task 1: Recognize BerniniStudio prompts and reference capacity

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `src/lib/comfyui/types.ts`
- Modify: `src/lib/comfyui/workflow-auto-mapping-types.ts`
- Test: `tests/unit/comfyui/workflow-auto-mapper.test.ts`

- [ ] **Step 1: Write failing analyzer tests**

Add Bernini API graph fixtures both with and without an authored `image0` socket. Assert that analysis returns high-confidence `prompt` and `negativePrompt` proposals, exactly one `referenceImages` proposal on the Bernini node with transform `bernini_image_slots`, synthesized `inputPath: 'image0'`, and `referenceCapacity: 8`. Assert the linked placeholder loader is not separately proposed.

- [ ] **Step 2: Run the analyzer test and verify RED**

Run: `pnpm vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: FAIL because Bernini prompt fields and `bernini_image_slots` do not exist yet.

- [ ] **Step 3: Implement the minimal analyzer rule**

Extend `ComfyBindingTransform` with `bernini_image_slots`. Detect exact `class_type === 'BerniniStudio'`, recognize its string `prompt` and `negative_prompt` inputs, emit a single eight-slot reference proposal when an `image0`-style link is present, and exclude loader nodes already wired to Bernini image sockets from generic loader inference.

- [ ] **Step 4: Run the analyzer test and verify GREEN**

Run: `pnpm vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts`

Expected: PASS.

### Task 2: Carry the Bernini binding through confirmation and contract validation

**Files:**
- Modify: `src/lib/comfyui/workflow-schema.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx`
- Test: `tests/unit/components/comfyui-workflow-settings.test.ts`
- Test: `tests/unit/comfyui/workflow-compiler.test.ts`

- [ ] **Step 1: Write failing confirmation and validation tests**

Assert that confirmation preserves `bernini_image_slots`, creates `{ name: 'referenceImages', type: 'image_ref_list', required: false, maxItems: 8, defaultValue: [] }`, and does not use `preserve_original`. Assert contract validation accepts the transform only for `BerniniStudio.image0` with an `image_ref_list` definition and rejects it on other node classes or paths.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/comfyui/workflow-compiler.test.ts`

Expected: FAIL because the transform is not accepted or preserved.

- [ ] **Step 3: Implement the minimal contract/UI support**

Add the transform to the bounded allowlists, make it compatible only with `image_ref_list`, preserve it in proposal confirmation, use `defaultValue: []` for optional Bernini references so zero images clears the sample link, and expose the transform in the mapping editor's enumerated choices.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm vitest run tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/comfyui/workflow-compiler.test.ts`

Expected: PASS.

### Task 3: Inject only the occupied Bernini image slots

**Files:**
- Modify: `src/lib/comfyui/workflow-renderer.ts`
- Test: `tests/unit/comfyui/workflow-compiler.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Cover zero, one, three, and eight uploads. For zero, assert all Bernini `image0` through `image7` inputs are removed. For N uploads, assert N new `LoadImage` nodes contain the uploaded filenames and Bernini `image0` through `image(N-1)` link to their output zero. Assert the source graph and uploads are unchanged, stale higher slots are removed, IDs do not collide with authored nodes, and nine values fail at the existing `maxItems` boundary.

- [ ] **Step 2: Run the compiler test and verify RED**

Run: `pnpm vitest run tests/unit/comfyui/workflow-compiler.test.ts`

Expected: FAIL because dynamic loader injection is not implemented.

- [ ] **Step 3: Implement the renderer transform**

Handle `bernini_image_slots` before ordinary path assignment. Validate the exact Bernini target, require a complete upload array matching the value array, delete only `/^image[0-7]$/` target inputs, allocate deterministic non-colliding node IDs, create standard `LoadImage` nodes, and wire compact slots in input order.

- [ ] **Step 4: Run the compiler test and verify GREEN**

Run: `pnpm vitest run tests/unit/comfyui/workflow-compiler.test.ts`

Expected: PASS.

### Task 4: Route existing Comfy image arrays to guided reference variables

**Files:**
- Modify: `src/lib/comfyui/request-service.ts`
- Test: `tests/unit/comfyui/request-state-machine.test.ts`
- Test: `tests/unit/generator-api.test.ts`

- [ ] **Step 1: Write a failing request test**

Create a selected workflow version whose definitions contain `referenceImages`, submit variables containing the legacy runtime key `input_images`, and assert the persisted snapshot contains `referenceImages`. Add the reverse compatibility case for a legacy version that still declares `input_images`.

- [ ] **Step 2: Run the request tests and verify RED**

Run: `pnpm vitest run tests/unit/comfyui/request-state-machine.test.ts tests/unit/generator-api.test.ts`

Expected: FAIL because the request sanitizer currently rejects or ignores the alias mismatch.

- [ ] **Step 3: Normalize the alias against the selected version**

Before sanitization, inspect the selected version's declared variable names. Rename `input_images` to `referenceImages` only when the selected contract declares the latter and not the former; retain the legacy name when it is declared. Reject ambiguous contracts that declare both names.

- [ ] **Step 4: Run the request tests and verify GREEN**

Run: `pnpm vitest run tests/unit/comfyui/request-state-machine.test.ts tests/unit/generator-api.test.ts`

Expected: PASS.

### Task 5: Preserve application reference ordering, include props, and label slots

**Files:**
- Modify: `src/lib/workers/handlers/image-task-handler-shared.ts`
- Modify: `src/lib/workers/handlers/panel-image-task-handler.ts`
- Test: `tests/unit/worker/panel-image-task-handler.test.ts`

- [ ] **Step 1: Write a failing reference-order test**

Build a panel with two characters, one location, and one prop asset. Assert collection order is character 1, character 2, location, prop, with absent assets compacted and no duplicated padding. Assert the panel's `props` field is forwarded to collection, the shared list is capped at eight before every consumer, and prompt context labels the compact sequence as `image0`, `image1`, and so on.

- [ ] **Step 2: Run the panel test and verify RED**

Run: `pnpm vitest run tests/unit/worker/panel-image-task-handler.test.ts`

Expected: FAIL because sketch currently precedes characters and props are not collected.

- [ ] **Step 3: Implement ordered compact collection**

Extend the local panel/project shapes with `props` and `assetKind`. Resolve typed reference entries with characters first in panel order, then the selected location image, then prop images in panel order, and append an explicit sketch only after semantic assets. Do not duplicate absent asset types. Add the exact compact `imageN` mapping to the prompt context.

- [ ] **Step 4: Run the panel test and verify GREEN**

Run: `pnpm vitest run tests/unit/worker/panel-image-task-handler.test.ts`

Expected: PASS.

### Task 6: Focused and static verification

**Files:**
- Review: all files changed above

- [ ] **Step 1: Run all focused behavior tests**

Run: `pnpm vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts tests/unit/comfyui/workflow-compiler.test.ts tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/comfyui/request-state-machine.test.ts tests/unit/generator-api.test.ts tests/unit/worker/panel-image-task-handler.test.ts`

Expected: PASS.

- [ ] **Step 2: Run type checking**

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 3: Run focused lint**

Run: `pnpm eslint src/lib/comfyui/types.ts src/lib/comfyui/workflow-auto-mapping-types.ts src/lib/comfyui/workflow-auto-mapper.ts src/lib/comfyui/workflow-schema.ts src/lib/comfyui/workflow-renderer.ts src/lib/comfyui/request-service.ts 'src/app/[locale]/profile/components/comfyui/workflow-requests.ts' 'src/app/[locale]/profile/components/comfyui/workflow-ui.ts' 'src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx' src/lib/workers/handlers/image-task-handler-shared.ts src/lib/workers/handlers/panel-image-task-handler.ts`

Expected: exit 0.

- [ ] **Step 4: Review the final diff for scope and safety**

Run: `git diff --check && git status --short && git diff --stat && git diff`

Expected: no whitespace errors; changes are limited to Bernini dynamic references, runtime aliasing, ordered prop references, tests, and this plan.
