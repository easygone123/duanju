# Guided ComfyUI Workflow Creation Design

**Date:** 2026-07-15

## Goal

Make new ComfyUI workflow creation usable without understanding node IDs,
variable types, binding paths, or output fields. The normal path must be:

1. Select a workflow type.
2. Upload one ComfyUI API Format JSON file.
3. Confirm a short summary and create the workflow.

The existing deterministic analyzer remains authoritative. This design changes
how its result is presented and confirmed; it does not replace the analyzer or
loosen server-side validation.

## Relationship to the Existing Auto-Mapping Design

This design refines the creation UI described in
`2026-07-13-comfyui-api-workflow-auto-mapping-design.md`. It supersedes that
document's requirement to show a complete confirmation table during normal
creation. Canonical inputs, deterministic inference, immutable graph handling,
version pinning, test-before-publish, and runtime binding behavior remain
unchanged.

## Scope

This change covers new workflow creation in ComfyUI settings:

- A full-width guided creation surface.
- A workflow-type picker with user-facing Chinese and English names.
- Drag-and-drop or file-picker upload of API Format JSON.
- Automatic naming from the uploaded filename.
- A concise analysis summary.
- Plain-language questions for required ambiguous mappings.
- A collapsed advanced mapping inspector.
- Responsive behavior with no horizontal page overflow.

Existing saved workflows retain their current advanced editor, validation,
test, version, publication, and compatibility features.

## Non-Goals

- Automatically infer the workflow type before upload.
- Accept normal ComfyUI browser Workflow JSON.
- Use an LLM to interpret workflow graphs.
- Add, remove, reconnect, or rewrite workflow nodes.
- Automatically publish an untested workflow.
- Hide blocking incompatibilities or bypass backend validation.
- Redesign connection-pool management or the saved-workflow library.

## Entry and Layout

The normal ComfyUI settings overview continues to show the connection pool and
saved workflow library. Selecting **New workflow** replaces that overview with
a dedicated full-width creation surface. The connection pool and saved
workflow list are hidden until the user exits or finishes the wizard.

The wizard content is centered with a maximum width of approximately 960px.
It owns vertical scrolling and never requires horizontal page scrolling. The
footer keeps the primary and back actions reachable without requiring users to
scroll past long technical details.

The creation surface is implemented separately from the saved-workflow
`WorkflowEditor`. This prevents beginner state and expert editing state from
sharing one large conditional component.

## Wizard State Machine

The wizard has three user-visible stages and explicit transitions:

### 1. Select type

The user chooses exactly one of:

- Text to image.
- Image to image.
- Image upscale.
- Text to video.
- Video to video.

The cards use user-facing labels and examples. Internal values such as
`mediaType` and `purpose` are not shown. The selected type determines the
existing `WorkflowImportKind` passed to analysis.

### 2. Upload JSON

The center of the page contains one large drop zone and an equivalent file
picker. It accepts one `.json` file within the existing size limit.

Before analysis begins, the wizard:

- Clears all results, answers, and errors from a previous upload.
- Derives a proposed workflow name from the filename by removing the final
  `.json` suffix and trimming whitespace.
- Allows the proposed name to be edited, but does not require a separate name
  entry before upload.

The upload is sent to the existing authenticated analysis endpoint with the
selected workflow type. A user can cancel back to type selection or replace
the file.

### 3. Review and create

The default view contains a concise summary, not a variable table. It reports
human-readable facts such as:

- Prompt input recognized.
- Source or reference media recognized.
- Primary image or video output recognized.
- Count of internal optional values preserved from the uploaded workflow.

When all required mappings are resolved, the user can create the draft with
one primary action. Creation uses the same confirmed binding overlay and
server validation as the existing implementation.

If required ambiguity exists, the review stage first presents only the
questions that must be answered. The create action remains disabled until all
required questions have answers.

## Mapping Presentation Policy

Every analyzer proposal is assigned to one presentation bucket:

### Automatically resolved

High-confidence required or supported canonical mappings are accepted without
asking the user. The summary describes the capability, not the node path.

### Preserved internally

Optional workflow-owned values keep their original graph value through the
existing `preserve_original` policy. They are counted in the summary but are
not shown as fields during normal creation.

### Requires an answer

Only ambiguity that prevents a valid confirmed overlay becomes a question.
Examples include:

- Which node receives the positive prompt?
- Which image input is the source image?
- Which candidate is the final generated output?

Options use node titles or a short fallback name. Node IDs, input paths, field
paths, confidence codes, and reason codes appear only inside per-option
technical details.

### Blocking

Missing or incompatible required capabilities prevent creation and show one
actionable error. The raw variable editor is not offered as a misleading way
to bypass a structurally invalid workflow.

## Advanced Settings

The review stage includes one collapsed **Advanced settings** disclosure. It
contains the complete mapping inspector for users who need to audit the
automatic result.

Opening the disclosure does not make optional variables mandatory. Advanced
changes are limited to choices already supported by the deterministic mapping
contract. Arbitrary node rewrites remain out of scope.

## Error Handling

Errors use user-facing messages and preserve a safe retry path:

- Invalid JSON: explain that the file cannot be read and allow replacement.
- Browser Workflow JSON: explain how to export ComfyUI API Format JSON.
- Oversized file: state the size limit before analysis.
- No compatible output: state that no final image or video output was found.
- Type mismatch: state which required input or output is missing for the
  selected workflow type and offer return to type selection.
- Network or server failure: preserve the selected type and proposed name,
  discard partial analysis, and allow retry.
- Backend confirmation failure: keep the uploaded analysis visible, show the
  safe localized reason, and do not create a partial workflow.

Uploading a replacement file always resets previous analysis, ambiguity
answers, output selection, and creation errors before processing the new file.

## Components and Responsibilities

### `WorkflowCreationWizard`

Owns the stage state machine, selected import kind, proposed name, current
analysis, ambiguity answers, primary output selection, and reset behavior. It
emits a completed `WorkflowAuthorDraft` or confirmed creation payload to its
parent.

### `WorkflowTypePicker`

Renders the five workflow-type cards and exposes only `WorkflowImportKind`.

### `WorkflowJsonDropzone`

Handles drag-and-drop, file selection, filename-derived naming, client-side
file validation, loading state, and replacement.

### `WorkflowAnalysisSummary`

Turns resolved proposals into capability-level summary rows and reports how
many optional internal values will be preserved.

### `WorkflowMappingQuestions`

Renders only unresolved required questions. It translates compatible mapping
choices into plain-language labels and keeps technical details collapsed.

### `WorkflowAdvancedMappingInspector`

Reuses or adapts the existing complete mapping view inside a disclosure. It is
not rendered as the default review surface.

### `WorkflowLibraryPanel` and `ComfyUiSettings`

Own whether the user sees the overview or the full-width wizard. They retain
saved workflow state, creation submission, connection testing, and publishing
outside the wizard.

## Data Flow

1. `WorkflowTypePicker` sets `WorkflowImportKind`.
2. `WorkflowJsonDropzone` reads and bounds one file, derives the draft name,
   and calls the existing analysis endpoint.
3. The endpoint returns `WorkflowAutoMappingResult`.
4. The wizard derives summary items, required questions, preserved-value
   count, and blocking issues without changing the underlying result.
5. User answers are stored as the existing canonical-role override map.
6. The existing confirmation function builds variable definitions, bindings,
   and outputs.
7. The existing create endpoint performs complete validation and saves the
   draft.
8. The user returns to the saved workflow view for real-node testing and
   publication.

No raw graph or confirmed overlay is trusted solely because it passed client
analysis.

## Responsive Rules

- The wizard root, every grid item, and every field wrapper use `min-width: 0`.
- The content wrapper is `width: 100%` with a bounded maximum width.
- Mapping questions are one column on phones and at most two columns on wider
  screens.
- Long titles wrap; node IDs and paths use break-safe technical details.
- Selects, inputs, and buttons cannot impose a width larger than their parent.
- The default review uses cards rather than a multi-column table.
- Only advanced technical blocks may scroll internally, and they must not
  cause page-level horizontal overflow.
- The layout is accepted at 375px, 768px, and 1440px viewport widths.

## Testing

### Unit and component tests

- Every workflow type maps to the correct `WorkflowImportKind`.
- File selection and drag-and-drop share the same upload path.
- `demo.workflow.json` derives the name `demo.workflow` and remains editable.
- Starting a replacement upload clears prior analysis and answers first.
- High-confidence mappings appear in the summary but not as editable fields.
- Optional proposals are counted and preserve their original value.
- Required ambiguous mappings produce plain-language questions.
- Multiple valid outputs require one primary-output answer.
- The create action is disabled only for blocking issues, unanswered required
  questions, an empty name, or an in-flight request.
- Advanced settings are collapsed by default and expose technical mappings on
  demand.
- Back and cancel transitions do not retain stale state in a later creation.

### API and contract tests

- Existing analysis and creation contracts remain authenticated and bounded.
- Confirmed answers compile to the same variable, binding, and output schema
  used by saved workflows.
- Invalid format, type mismatch, missing output, and backend validation errors
  return safe actionable codes.
- Replacement analysis cannot reuse overrides from another graph.

### Responsive acceptance

- Render the wizard at 375px, 768px, and 1440px widths.
- Assert that the wizard root and page do not exceed their viewport width.
- Verify long node titles, multiple output choices, and expanded advanced
  details do not introduce page-level horizontal scrolling.
- Verify primary and back actions remain reachable with long content.

### Regression

- Saved workflow editing, validation, real-node testing, publication,
  compatibility checks, and pinned execution continue to pass.
- Existing deterministic analyzer coverage remains unchanged.

## Acceptance Criteria

1. A normal user creates a valid draft by selecting a type, uploading JSON,
   and confirming a summary without seeing the variable editor.
2. The workflow name defaults to the uploaded filename and can be changed
   before creation.
3. Optional inputs silently preserve workflow defaults.
4. Only required ambiguity interrupts the normal flow, using plain-language
   questions.
5. Full mapping details remain available but collapsed under advanced
   settings.
6. Invalid or incompatible workflows fail with an actionable explanation and
   do not create partial records.
7. Replacing a file cannot retain mappings or answers from the previous file.
8. The creation surface has no page-level horizontal overflow at 375px,
   768px, or 1440px.
9. Saved workflow testing and publication behavior is unchanged.

