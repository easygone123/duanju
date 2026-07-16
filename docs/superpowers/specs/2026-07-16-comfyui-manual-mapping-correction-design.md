# ComfyUI Manual Mapping Correction Design

## Problem

The guided ComfyUI workflow importer reports missing required inputs, such as `prompt`, but only allows role changes for mappings classified as ambiguous. A high-confidence misclassification is locked, and a workflow input omitted by the analyzer has no row at all. Users therefore cannot recover inside the guided flow.

## Goal

Let users correct automatic mappings without editing JSON, node IDs, or field paths by hand. A correction must immediately participate in readiness validation and produce the same validated workflow contract as an automatic mapping.

## User Experience

The review stage keeps automatic mappings as defaults but treats them as suggestions:

- Every detected input mapping has an enabled role selector unless creation is busy or completed.
- A user can change a high-confidence mapping to any type-compatible canonical role.
- When a required canonical input is still missing, the review stage shows a manual correction control for that input.
- The control lists compatible, currently unbound literal inputs from the uploaded API-format graph using a friendly node title and field name. Node ID and full input path remain available as technical details.
- Selecting a candidate immediately removes the matching missing-input warning when the complete review becomes valid.
- A field already assigned to another canonical input cannot be selected twice.
- Multiple analyzer-detected fields may fan out from the same canonical input; they share one variable definition and keep separate bindings.
- Users may clear a manual selection and choose another candidate before creation.

The primary path remains guided. The existing advanced inspector stays available but is not required to fix a missing prompt.

## Candidate Rules

Manual candidates are derived from the analyzed API graph, not from arbitrary user-entered paths.

- `prompt` and `negativePrompt` accept literal string inputs.
- Numeric canonical inputs accept finite literal number inputs.
- Boolean canonical inputs accept literal boolean inputs when supported by the contract.
- Media canonical inputs accept analyzer-recognized compatible media inputs; list-valued image references map only to `referenceImages`, while single-image references may map to a compatible single-image role or `referenceImages`. This change does not invent arbitrary upload paths.
- Graph-link arrays, objects, output references, and fields already bound by an effective mapping are excluded.
- Candidate ordering is deterministic: node order, then input-path order.

The initial implementation must fully support the reported `prompt` recovery path and use shared type-compatible candidate helpers so other scalar required inputs follow the same safety rules.

## State and Contract

The wizard owns a `manualMappings` state keyed by canonical input. Each entry contains only a candidate returned from the analyzed graph: node ID, input path, value type, and optional node title.

Review derivation combines:

1. analyzer proposals plus user role overrides;
2. manual mappings for still-unmapped canonical inputs;
3. the selected primary output.

Contract confirmation uses the same combined mapping set. It must reject:

- a node or input path not present in the analyzed graph;
- an incompatible value type;
- duplicate effective node/path bindings;
- a manual canonical input that is already occupied by any effective analyzer mapping;
- missing required inputs;
- an invalid primary output.

After role overrides, required status is derived from the final canonical input and the selected import kind. Fan-out bindings for one canonical input share one variable definition and the same missing-value policy.

Manual mappings are reset when the file or workflow kind changes, analysis is retried or replaced, or the wizard returns to an earlier stage.

## Error Handling and Accessibility

- Missing-input controls are placed next to the missing-input review state and are reachable without opening advanced settings.
- Labels use localized canonical input names.
- Empty candidate lists show a localized explanation that the uploaded graph has no compatible editable field.
- Validation errors use the existing safe workflow error keys and never expose raw workflow JSON.
- Controls are disabled while creation is pending or after completion.
- Status and alert semantics remain available to assistive technology.

## Validation

Per the project owner's direction, this change will not add or run automated tests. Before submission, run only TypeScript checking, lint on affected files, translation-key parity inspection, and `git diff --check`. Do not run the repository-wide test suite.

## Non-Goals

- Free-form node ID or input-path entry.
- Editing the uploaded graph JSON.
- Guessing media upload paths the analyzer cannot recognize.
- Replacing the saved-workflow advanced editor.
