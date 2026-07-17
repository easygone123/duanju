# Six-grid stored prompt delivery design

## Problem

Six-grid storyboard planning persists the exact generated sheet prompt in
`NovelPromotionStoryboard.sheetPromptSnapshot`. The storyboard workspace loads its
data from the episode stage endpoint, but that endpoint's storyboard projection
does not select `sheetPromptSnapshot`. As a result, the prompt modal receives
`undefined` and incorrectly tells the user to rerun planning even when the prompt
already exists in the database.

## Chosen approach

Add `sheetPromptSnapshot` to the storyboard-stage Prisma projection and to the
corresponding TypeScript projection contract. The existing modal continues to
render the value without modifying it.

This is preferred over two alternatives:

- Rebuilding a prompt from current panels could differ from the original planning
  prompt and therefore would not satisfy the promise to show the saved original.
- Reading a graph/run artifact as a fallback would introduce another data source
  and ambiguous precedence when the storyboard snapshot is the canonical value.

## Data flow

1. Six-grid planning builds the sheet prompt and persists it in
   `sheetPromptSnapshot` on the storyboard row.
2. `GET /api/novel-promotion/:projectId/episodes/:episodeId/stage/storyboard`
   selects and returns `sheetPromptSnapshot` for each storyboard.
3. The workspace stage query retains the field in its typed payload.
4. `StoryboardGroup` passes the exact value to `SixGridPromptModal`.
5. The modal displays and copies the original string unchanged.

## Empty historical records

If `sheetPromptSnapshot` is genuinely `null` or blank in the database, the modal
keeps its existing missing-state message. The application does not reconstruct or
silently replace the original prompt.

## Testing

Extend the episode-stage route contract fixture with a saved six-grid prompt and
assert that the storyboard-stage response returns the exact string. Also assert
that unrelated stage projections do not gain this field. Existing modal tests
continue to cover exact display, exact clipboard copying, and the genuine-empty
state.

## Scope

This change affects only the storyboard-stage read projection and its TypeScript
contract. It does not alter prompt generation, persistence, the modal UI, or old
records whose snapshot is truly absent.
