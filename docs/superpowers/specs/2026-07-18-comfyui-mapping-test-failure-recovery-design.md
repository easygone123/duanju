# ComfyUI Mapping Test Failure Recovery Design

## Problem

The guided ComfyUI importer can produce an input or output mapping that passes
static validation but fails against a real ComfyUI instance. While the
activation panel is open, the workflow library disables the complete workflow
editor. After a failed test, the activation panel remains open and emphasizes
retrying the same immutable version, so the user cannot directly repair the
incorrect mapping.

## Goal

Give a failed workflow test an explicit recovery path back to the editable
input and output mappings. The user must be able to repair the draft, save a
new version, and test that exact new version without losing the failure context
or accidentally testing unsaved edits.

## User Experience

When activation testing fails:

- Keep the localized failure reason visible in the activation panel.
- Show a prominent `Return to edit mappings` action next to the retry action.
- Selecting it closes the activation panel, unlocks the workflow editor, and
  moves focus to the input/output mapping editor.
- Preserve the workflow JSON, variables, bindings, outputs, and test form data
  already loaded in the library.
- Show a short editing hint explaining that changes must be saved before the
  workflow can be tested again.
- After the user saves the repaired draft, the library receives the newly
  created immutable version and `Test and enable` tests that version.

The normal close action remains available. Successful tests and publication
continue through the existing activation flow.

## Component Boundaries

### `WorkflowActivationPanel`

The panel owns the failed-test state and renders the recovery action only when
`activation.error === 'test'`. It exposes an `onEditMappings` callback to the
library. It does not mutate workflow data or create versions itself.

### `WorkflowLibraryPanel`

The library handles `onEditMappings` by closing activation, retaining the
current author draft, entering a short mapping-repair state, and requesting
focus for the mapping editor. The repair state is cleared when the user
selects another workflow or successfully saves a new version.

### `WorkflowEditor` and `WorkflowMappingTable`

The editor accepts a focus request for the mapping area. The mapping table has
a stable focus target at its heading so keyboard and screen-reader users land
at the editable controls. Existing manual node IDs, input paths, variables,
transforms, output nodes, field paths, and primary-output controls remain the
authoritative repair surface.

## Data and Version Flow

1. Activation tests saved version `N`.
2. The test fails and the panel preserves its localized error state.
3. `Return to edit mappings` closes activation and unlocks the draft derived
   from version `N`.
4. The user changes mappings locally. No test is allowed against unsaved data.
5. `Save draft` creates immutable version `N+1` using the repaired contract.
6. The library reloads and selects version `N+1`.
7. `Test and enable` tests and publishes version `N+1` through the existing
   activation path.

## Error Handling

- A test failure never changes or publishes the saved version.
- Returning to edit never discards the author draft.
- The raw ComfyUI response is not shown; existing safe localized error keys
  remain in use.
- Retry continues testing the unchanged saved version.
- Switching workflows clears the repair hint and any pending focus request.
- Saving failure leaves the repaired draft visible and editable.

## Accessibility

- The recovery action is a real button and is available only after test
  failure.
- After activation closes, focus moves to the mapping section heading rather
  than the top of the page.
- The repair hint uses status semantics and explains the save-before-retest
  requirement.
- Existing disabled and busy semantics remain unchanged during requests.

## Validation

- Component test: a failed activation test exposes `Return to edit mappings`
  and invokes `onEditMappings` once.
- Component test: the recovery callback closes activation and unlocks the
  workflow editor without discarding the draft.
- Component test: focus moves to the input/output mapping section.
- Component test: switching workflows or saving a repaired version clears the
  repair state.
- Regression tests: retry still tests the same version; successful activation
  behavior is unchanged.
- Run focused Vitest suites, TypeScript checking, ESLint for changed files,
  translation-key parity, and `git diff --check` before the full push gate.

## Non-Goals

- Re-running automatic mapping after a failed test.
- Editing mappings inside the activation panel.
- Testing unsaved workflow drafts.
- Changing the workflow contract, database schema, or ComfyUI request format.
- Exposing raw provider diagnostics.
