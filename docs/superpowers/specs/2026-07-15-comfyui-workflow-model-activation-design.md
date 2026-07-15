# ComfyUI Workflow Model Activation Design

## Goal

Make a newly created ComfyUI generation workflow become selectable as a system image or video model through one guided activation path.

## Activation flow

1. Creating the workflow still persists a private draft and immutable version.
2. The guided flow moves to a `Test and enable` stage instead of ending without an explanation.
3. The user selects one enabled owned ComfyUI instance.
4. The form asks only for required live-test variables and uploads already declared by the analyzed workflow contract.
5. A successful live test records the tested connection and timestamp through the existing test-run route.
6. The client then publishes that exact tested version through the existing publish route.
7. After publication, the client invalidates the user-model query and reports that the workflow is ready in the image, video, or upscale model group matching its media type and purpose.

## Failure behavior

- No enabled instance: keep the workflow as a draft and explain that an instance must be added or enabled.
- Missing required test input: keep activation blocked and identify the missing fields locally.
- Test failure: do not publish; preserve the draft and show the existing safe localized failure category.
- Publish failure after a successful test: keep the tested draft selected and offer publish retry without repeating the live test.
- Closing activation never deletes the saved draft.

## Eligibility and safety

Do not weaken the existing model-list eligibility rules. A selectable ComfyUI model must remain owner-scoped, pinned to the current version, published, content-hashed, and successfully tested on an instance owned by the same user. Static validation and the existing workflow-purpose routing remain authoritative.

## UI integration

- Reuse `WorkflowTestForm` for required variables and uploads.
- Reuse the existing instance query, test-run route, publish route, and user-model query invalidation.
- Show a concise readiness state: `Draft`, `Needs test`, `Ready to publish`, or `Available as model`.
- Generation workflows appear in image or video model selectors; upscale workflows appear only in the upscale selector.

## Verification

Automated coverage must prove:

1. Creation enters activation with the new workflow and version selected.
2. Missing instance or required inputs prevents test submission.
3. Test failure never calls publish.
4. Test success publishes the exact tested version.
5. Publish success invalidates user models and produces the available state.
6. Publish retry after a successful test does not rerun the test.
7. The user-model endpoint continues to exclude drafts, untested versions, foreign-instance tests, and invalid upscale contracts.
