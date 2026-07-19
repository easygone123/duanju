# ComfyUI Workflow Edit, Test, and Publish Design

**Date:** 2026-07-20

## Goal

Replace the saved-workflow library's always-expanded raw editor with a focused
edit window that reuses the guided creation mapping experience. Editing must
flow directly into testing the exact edited contract and publishing that exact
tested version, without a separate user-visible “save draft” step.

## Confirmed user flow

1. The workflow library shows a compact workflow summary and actions.
2. **Edit workflow** opens a full-width editor prefilled with the selected
   workflow JSON, variables, input mappings, and output mappings.
3. The user can add, change, or remove mappings with the guided mapping editor.
4. **Continue to test** automatically creates an immutable test snapshot from
   the current editor values.
5. The test form is derived from that new snapshot, so every current media
   mapping—including optional `firstFrame` and `lastFrame` mappings—is shown.
6. A successful test unlocks **Publish workflow**. Publication is a separate
   user action and targets the exact version that passed the test.
7. Returning to edit invalidates the prepared test state. Continuing again
   creates and tests a new snapshot.

There is no user-visible **Save draft** action in the normal editing flow.
Creating an immutable version before a live test remains an internal backend
requirement, not an extra decision the user must understand.

## Root cause addressed

The previous library kept two states:

- `authorDraft`, updated by the inline editor; and
- `savedVersion`, used to build the test form and submit test requests.

This allowed the editor to show a newly mapped first frame while the test form
still used an older version containing only the last-frame mapping. The new
flow materializes the current editor contract before opening the test form and
passes the returned version directly into activation.

## Library layout

The selected workflow detail keeps only:

- workflow name, media type, purpose, and status;
- latest-version validation and test state;
- compact capability and compatibility summaries;
- **Edit workflow**, **Test published/latest version** when appropriate, and
  **Delete workflow** actions.

The raw `WorkflowEditor`, variable list, and mapping table are removed from the
overview. Failed activation's **Return to edit mappings** action opens the same
full-width edit window.

## Edit window

The edit window reuses `WorkflowCreationWizard` presentation and the existing
`WorkflowGuidedMappingEditor`. Edit mode:

- skips workflow-type selection;
- starts at review with the selected workflow prefilled;
- treats media type and purpose as immutable;
- preserves definition metadata such as duration defaults, options, and
  missing-value policies when a canonical mapping remains present;
- allows mapping additions, role changes, removals, and output correction;
- exposes cancel and continue-to-test actions.

The existing creation path remains unchanged.

## Test and publish state

Edit mode prepares a version only when the user continues to test. The client
updates workflow metadata, creates the immutable version, and uses the returned
version object as the sole source for the test form.

Testing and publishing are deliberately separate:

- failed test: stay on the test step and do not publish;
- successful test: transition to ready-to-publish;
- failed publish: retain the tested version and allow publish retry;
- successful publish: invalidate model queries and return to the workflow
  library with the workflow selected;
- any mapping edit after preparation: discard the prepared-version reference
  and require a fresh test.

## Error handling

- Version creation failure leaves all edit values intact and offers retry.
- Static validation failure prevents entering the test step and shows the
  existing safe workflow error.
- Missing required test media keeps the test action disabled.
- Optional media mappings remain visible so first/last-frame workflows can be
  tested even when those definitions use `preserve_original`.
- Canceling edit does not create a version or change the published model.

## Verification boundary

Regression coverage should prove that:

1. an edit draft containing both first and last frame mappings produces both
   definitions in the prepared version;
2. the activation form shows both optional frame uploads;
3. live-test success does not publish automatically;
4. publish uses the same tested version ID;
5. the library no longer renders the inline raw editor and opens edit mode
   through an explicit action.

Per the user's instruction for this task, automated tests are added where
appropriate but are not executed; static diff checks are the verification
boundary for the handoff.
