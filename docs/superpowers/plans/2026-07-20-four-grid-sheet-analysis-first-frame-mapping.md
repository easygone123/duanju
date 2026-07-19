# Four-grid Sheet Analysis and First-frame Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analyze a generated four-grid sheet against its planned plot before cropping so every cell receives grounded image/video prompts and duration, while preventing an unconfirmed ComfyUI first-frame mapping from being silently omitted.

**Architecture:** Extend the immutable crop task snapshot with the selected analysis model. The crop worker will load the owned sheet and planned panel rows, run one vision request over the complete 2x2 image, validate exactly four numbered results, then crop and atomically persist the image plus the corresponding prompt/timing metadata. Separately, guided ComfyUI mapping drafts will treat ambiguous candidates as unresolved until the user explicitly selects a role or removes the candidate.

**Tech Stack:** Next.js route handlers, BullMQ workers, Prisma, Zod, existing AI runtime vision gateway, React guided workflow editor, Vitest regression specifications.

---

### Task 1: Define and validate four-grid sheet analysis

**Files:**
- Create: `src/lib/novel-promotion/grid-storyboard/sheet-analysis.ts`
- Test: `tests/unit/novel-promotion/four-grid-sheet-analysis.test.ts`

- [ ] Define a strict result contract containing `panel_number`, `description`, `image_prompt`, `video_prompt`, `duration`, `shot_type`, and `camera_move`.
- [ ] Build a vision prompt that includes the 2x2 reading order, the original four planned plot beats, dialogue, characters, locations, props, and planned total duration, while declaring plot facts authoritative and the generated sheet visual evidence.
- [ ] Parse repaired JSON and require exactly four unique rows numbered `1..4`, non-empty prompts, and finite positive durations.
- [ ] Keep the returned rows sorted by panel number so `panel_number - 1` is the only cell assignment rule.
- [ ] Add regression specifications for valid ordering, missing/duplicate cells, empty prompts, and invalid durations. Do not execute them per the user's request.

### Task 2: Analyze before crop and atomically bind metadata

**Files:**
- Modify: `src/lib/workers/handlers/storyboard-sheet-task-handler.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route.ts`
- Modify: `src/lib/workers/handlers/storyboard-crop-task-handler.ts`
- Test: `tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts`
- Test: `tests/unit/worker/storyboard-crop-task-handler.test.ts`
- Test: `tests/system/four-grid-storyboard.system.test.ts`

- [ ] Add `analysisModelSnapshot` to crop snapshots and their dedupe identity; the authenticated crop route resolves it from project model configuration for four-grid requests.
- [ ] In the crop worker, verify the source sheet and storyboard ownership, read the source media bytes directly from storage, and run the four-grid vision analysis before calling the crop service.
- [ ] Pass the validated four analysis rows into `commitSixGridCropBatch` and update `description`, `imagePrompt`, `videoPrompt`, `shotType`, `cameraMove`, `duration`, and `estimatedDuration` together with each matching crop artifact.
- [ ] Preserve existing six-grid behavior by only requiring/running the new analysis for `gridSpec.mode === 'four_grid'`.
- [ ] Ensure an analysis failure leaves the sheet intact and produces no cropped panel mutation; task retry can analyze the same immutable source snapshot again.
- [ ] Add regression specifications for analysis-before-crop call order, exact `gridCellIndex` assignment, atomic metadata/image persistence, and unchanged six-grid execution. Do not execute them per the user's request.

### Task 3: Require explicit confirmation for ambiguous frame mappings

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowEditWizard.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Test: `tests/unit/components/comfyui-guided-mapping-draft.test.ts`
- Test: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`
- Test: `tests/unit/components/comfyui-workflow-edit-wizard.test.tsx`

- [ ] Add an `unconfirmedInput` guided-draft issue whenever a retained proposal still has `confidence: 'ambiguous'`.
- [ ] Render an empty “choose mapping role” option for ambiguous candidates instead of displaying their guessed canonical role as if it were confirmed.
- [ ] Make selecting the displayed role call `updateGuidedInputRole`, changing the proposal to `confidence: 'high'`; removing the mapping remains the explicit preserve-original path.
- [ ] Block creation and test preparation while any ambiguous candidate remains, so a first-frame loader cannot disappear silently while a confirmed last-frame loader is saved.
- [ ] Add regression specifications reproducing two unlabeled `LoadImage` nodes where first frame is explicitly selected and last frame is explicitly selected, asserting that both definitions and bindings reach the prepared version. Do not execute them per the user's request.

### Task 4: Static verification and integration

**Files:**
- Modify only files from Tasks 1-3.

- [ ] Run `git diff --check`.
- [ ] Parse `messages/zh.json` and `messages/en.json` as JSON.
- [ ] Review the diff for accidental changes and confirm `package-lock.json` is untouched in the feature worktree.
- [ ] Do not run Vitest, TypeScript, build, or provider integration tests, per the user's explicit request.
- [ ] Commit the two logical fixes, fast-forward local `main`, and push `duanju/main` only when requested or as part of the user's established GitHub handoff.
