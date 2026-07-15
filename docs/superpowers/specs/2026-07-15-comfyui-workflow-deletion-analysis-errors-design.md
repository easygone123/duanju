# ComfyUI Workflow Deletion and Analysis Diagnostics Design

## Goal

Let users remove workflows from the active library and understand why an uploaded ComfyUI workflow cannot be analyzed.

## Workflow removal

- Add a destructive action for the selected saved workflow with a confirmation step.
- Reuse the existing owned-workflow `DELETE` route and archival service; do not hard-delete versions, execution history, or generated assets.
- Exclude archived workflows from the normal owned-workflow list.
- After successful archival, clear the selected editor state and reload the library.
- When a workflow is still selected as a project default, keep the server-side conflict guard and show a specific instruction to clear that default before retrying.
- New, unsaved workflows do not show the removal action.

## Analysis diagnostics

- Preserve the server's bounded `error.details.reason` diagnostic through the client request layer instead of collapsing every analysis rejection to `INVALID_PARAMS`.
- Map known reasons to localized, actionable messages without exposing raw workflow contents or server errors.
- Continue accepting a top-level ComfyUI API Format graph.
- Also accept the common request wrapper `{ "prompt": <API Format graph> }` when `prompt` is the only graph payload being analyzed.
- Continue rejecting normal UI Workflow JSON containing `nodes` and `links`; explain that the user must export API Format JSON.
- Continue rejecting malformed nodes that lack a non-empty `class_type` or object `inputs`.
- Treat missing or ambiguous output nodes as review-stage workflow issues, not transport or generic parsing failures.

## Security and data integrity

- Deletion remains owner-scoped and archival remains transactional.
- Project-default references continue to block archival.
- Analysis responses expose only stable reason codes and localized client text.
- Wrapper extraction must still apply the existing JSON byte, graph shape, and contract limits to the extracted graph.

## Verification

Automated coverage must prove:

1. The library calls the owned-workflow delete route only after confirmation.
2. Successful archival resets selection and removes the workflow from the active list.
3. Project-default conflicts produce a specific safe message.
4. Archived workflows are absent from list results.
5. API Format, wrapped API Format, normal UI Workflow JSON, and malformed graph uploads produce distinct expected outcomes.
6. Raw workflow contents and unexpected server errors never appear in the UI.
