# Internal Media Proxy Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Restore storyboard image previews and finished-film video playback by making the same-origin `/m/{publicId}` proxy fetch storage through the server-reachable MinIO endpoint while preserving browser-facing signed URLs and video byte ranges.

**Architecture:** Add an explicit internal signed-object URL to the storage provider boundary. MinIO will use its internal client for proxy fetch URLs and its existing public client for browser redirects; local storage will reuse its same-origin file route. The media proxy will consume the new facade helper directly and continue streaming upstream bodies and range metadata.

**Tech Stack:** Next.js 15 App Router, TypeScript, AWS S3 SDK/MinIO, Vitest, ESLint

---

## Task 1: Separate public and internal storage signing

**Files:**
- Modify: `src/lib/storage/types.ts`
- Modify: `src/lib/storage/providers/minio.ts`
- Modify: `src/lib/storage/providers/local.ts`
- Modify: `src/lib/storage/providers/cos.ts`
- Modify: `src/lib/storage/index.ts`
- Test: `tests/unit/storage/streaming-object.test.ts`

- [ ] **Step 1: Add a failing MinIO endpoint-separation test**

Extend the existing public-endpoint test in `tests/unit/storage/streaming-object.test.ts` so it signs one browser URL and one internal URL:

```ts
it('uses separate public and internal endpoints for signed URLs', async () => {
  process.env.MINIO_PUBLIC_ENDPOINT = 'http://localhost:19000'
  const provider = new MinioStorageProvider()
  getSignedUrlMock
    .mockResolvedValueOnce('http://localhost:19000/waoowaoo/images/panel.png?public=1')
    .mockResolvedValueOnce('http://minio:9000/waoowaoo/images/panel.png?internal=1')

  await expect(provider.getSignedObjectUrl({
    key: 'images/panel.png',
    expiresInSeconds: 3600,
  })).resolves.toContain('localhost:19000')

  await expect(provider.getInternalSignedObjectUrl({
    key: 'images/panel.png',
    expiresInSeconds: 3600,
  })).resolves.toContain('minio:9000')

  expect(getSignedUrlMock).toHaveBeenNthCalledWith(
    1,
    s3ClientMock.mock.results[0]?.value,
    expect.anything(),
    { expiresIn: 3600 },
  )
  expect(getSignedUrlMock).toHaveBeenNthCalledWith(
    2,
    s3ClientMock.mock.results[1]?.value,
    expect.anything(),
    { expiresIn: 3600 },
  )
})
```

Use `MINIO_ENDPOINT=http://minio:9000` in this test so the assertions name the same internal host used by Docker.

- [ ] **Step 2: Run the storage test and confirm the contract is missing**

Run:

```bash
npx vitest run tests/unit/storage/streaming-object.test.ts
```

Expected: FAIL because `getInternalSignedObjectUrl` does not exist on `MinioStorageProvider`.

- [ ] **Step 3: Add the provider contract and implementations**

Add the method to `StorageProvider` in `src/lib/storage/types.ts`:

```ts
getInternalSignedObjectUrl(params: SignedUrlParams): Promise<string>
```

In `src/lib/storage/providers/minio.ts`, factor the shared signing logic and make the endpoint choice explicit:

```ts
private async signObjectUrl(
  client: S3ClientLike,
  params: SignedUrlParams,
): Promise<string> {
  const sdk = await this.loadSdk()
  const presigner = await this.loadPresigner()

  return await presigner.getSignedUrl(
    client,
    new sdk.GetObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
    }),
    { expiresIn: params.expiresInSeconds },
  )
}

async getSignedObjectUrl(params: SignedUrlParams): Promise<string> {
  return await this.signObjectUrl(await this.getSigningClient(), params)
}

async getInternalSignedObjectUrl(params: SignedUrlParams): Promise<string> {
  return await this.signObjectUrl(await this.getClient(), params)
}
```

In `src/lib/storage/providers/local.ts`, validate and return the same local file URL by delegating:

```ts
async getInternalSignedObjectUrl(params: SignedUrlParams): Promise<string> {
  return await this.getSignedObjectUrl(params)
}
```

In `src/lib/storage/providers/cos.ts`, preserve the provider's current fail-closed behavior:

```ts
async getInternalSignedObjectUrl(_params: SignedUrlParams): Promise<string> {
  throw new StorageProviderNotImplementedError('cos')
}
```

Update the typed provider mock in `tests/unit/storage/streaming-object.test.ts` with `getInternalSignedObjectUrl: vi.fn()`.

- [ ] **Step 4: Add the facade helper and a local-URL regression test**

Add to `src/lib/storage/index.ts`:

```ts
export async function getInternalObjectUrl(
  key: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRES_SECONDS,
): Promise<string> {
  const internalUrl = await getStorageProvider().getInternalSignedObjectUrl({
    key,
    expiresInSeconds,
  })
  return toFetchableUrl(internalUrl)
}
```

Add a facade test proving that a provider-relative `/api/files/...` result is normalized for server-side fetch and that the new provider method receives the key and TTL:

```ts
it('normalizes the provider internal URL for server-side fetch', async () => {
  facadeGetInternalSignedObjectUrlMock.mockResolvedValue('/api/files/images%2Fpanel.png')
  facadeToFetchableUrlMock.mockReturnValue('http://app:3000/api/files/images%2Fpanel.png')

  await expect(storageFacade.getInternalObjectUrl('images/panel.png', 60))
    .resolves.toBe('http://app:3000/api/files/images%2Fpanel.png')
})
```

Hoist named mock references for `getInternalSignedObjectUrl` and `toFetchableUrl` rather than reaching through anonymous mock objects.

- [ ] **Step 5: Run storage tests until green**

Run:

```bash
npx vitest run tests/unit/storage/streaming-object.test.ts
```

Expected: PASS, including proof that public signing uses `MINIO_PUBLIC_ENDPOINT`, internal signing uses `MINIO_ENDPOINT`, and local URLs become fetchable absolute URLs.

- [ ] **Step 6: Commit the storage boundary**

```bash
git add src/lib/storage/types.ts src/lib/storage/providers/minio.ts src/lib/storage/providers/local.ts src/lib/storage/providers/cos.ts src/lib/storage/index.ts tests/unit/storage/streaming-object.test.ts
git commit -m "fix: separate internal media storage signing"
```

## Task 2: Route media proxy reads through the internal storage URL

**Files:**
- Create: `tests/unit/media/media-proxy-route.test.ts`
- Modify: `src/app/m/[publicId]/route.ts`

- [ ] **Step 1: Create failing image and video proxy tests**

Create `tests/unit/media/media-proxy-route.test.ts` with hoisted mocks for the media lookup and storage facade:

```ts
const {
  fetchMock,
  getInternalObjectUrlMock,
  getMediaObjectByPublicIdMock,
  getSignedUrlMock,
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getInternalObjectUrlMock: vi.fn(),
  getMediaObjectByPublicIdMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
}))

vi.mock('@/lib/media/service', () => ({
  getMediaObjectByPublicId: getMediaObjectByPublicIdMock,
}))

vi.mock('@/lib/storage', () => ({
  getInternalObjectUrl: getInternalObjectUrlMock,
  getSignedUrl: getSignedUrlMock,
  toFetchableUrl: vi.fn(),
}))
```

Use `beforeEach` to stub `globalThis.fetch`, return a minimal media record, and resolve the internal URL:

```ts
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  getInternalObjectUrlMock.mockResolvedValue(
    'http://minio:9000/waoowaoo/projects/panel.png?signed=1',
  )
  getMediaObjectByPublicIdMock.mockResolvedValue({
    id: 'media-1',
    publicId: 'public-1',
    storageKey: 'projects/panel.png',
    mimeType: 'image/png',
    sha256: 'abc123',
    updatedAt: new Date('2026-07-18T00:00:00.000Z'),
  })
})
```

Add an image test that supplies a `200` upstream response and asserts:

```ts
expect(getInternalObjectUrlMock).toHaveBeenCalledWith('projects/panel.png')
expect(fetchMock).toHaveBeenCalledWith(
  expect.stringContaining('http://minio:9000/'),
  { headers: undefined },
)
expect(getSignedUrlMock).not.toHaveBeenCalled()
expect(response.status).toBe(200)
expect(response.headers.get('content-type')).toBe('image/png')
expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes)
```

Add a video range test using `Range: bytes=0-1023` and an upstream `206` response. Assert that the route forwards the Range request and preserves:

```ts
expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
  headers: { Range: 'bytes=0-1023' },
})
expect(response.status).toBe(206)
expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096')
expect(response.headers.get('content-length')).toBe('1024')
expect(response.headers.get('accept-ranges')).toBe('bytes')
```

Use `new NextRequest('http://localhost/m/public-1', { headers })` and call `GET(request, { params: Promise.resolve({ publicId: 'public-1' }) })`.

- [ ] **Step 2: Run the route test and confirm it fails on the old helper path**

Run:

```bash
npx vitest run tests/unit/media/media-proxy-route.test.ts
```

Expected: FAIL because the route still calls `getSignedUrl`/`toFetchableUrl`, not `getInternalObjectUrl`.

- [ ] **Step 3: Switch `/m` to the internal object URL**

In `src/app/m/[publicId]/route.ts`, change the storage import and await the new helper:

```ts
import { getInternalObjectUrl } from '@/lib/storage'
const fetchUrl = await getInternalObjectUrl(media.storageKey)
```

Leave these existing response semantics intact:

- forward the incoming `Range` header;
- return upstream `206` as `206`;
- copy `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges`;
- stream `upstream.body` instead of buffering;
- keep existing `404`, `500`, `502`, ETag, immutable-cache, and `HEAD` behavior.

- [ ] **Step 4: Run the route test until green**

Run:

```bash
npx vitest run tests/unit/media/media-proxy-route.test.ts
```

Expected: PASS for a full image response and a ranged video response, with no call to the browser redirect helper.

- [ ] **Step 5: Run the focused storage and route regression set**

Run:

```bash
npx vitest run tests/unit/storage/streaming-object.test.ts tests/unit/media/media-proxy-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the media proxy fix**

```bash
git add src/app/m/'[publicId]'/route.ts tests/unit/media/media-proxy-route.test.ts
git commit -m "fix: proxy media through internal storage endpoint"
```

## Task 3: Validate the full change and document any unrelated baseline failure

**Files:**
- Verify only; no planned production-code changes

- [ ] **Step 1: Run focused lint and type checks**

Run:

```bash
npx eslint src/lib/storage/types.ts src/lib/storage/providers/minio.ts src/lib/storage/providers/local.ts src/lib/storage/providers/cos.ts src/lib/storage/index.ts src/app/m/'[publicId]'/route.ts tests/unit/storage/streaming-object.test.ts tests/unit/media/media-proxy-route.test.ts
npm run typecheck
git diff --check HEAD~2..HEAD
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the unit suite**

Run:

```bash
npm run test:unit:all
```

Expected: PASS. If an unrelated test fails, reproduce it on the unchanged base commit before classifying it as a baseline failure.

- [ ] **Step 3: Run a production build**

Run:

```bash
npm run build
```

Expected: exit `0`. Redis connection warnings during static collection are acceptable only if the build completes successfully; any compile or route-build error is a blocker.

- [ ] **Step 4: Inspect the final diff against the approved design**

Run:

```bash
git diff --stat f7b489c..HEAD
git diff f7b489c..HEAD -- src/lib/storage src/app/m/'[publicId]'/route.ts tests/unit/storage/streaming-object.test.ts tests/unit/media/media-proxy-route.test.ts
git status --short
```

Confirm:

- browser redirects still use `MINIO_PUBLIC_ENDPOINT`;
- `/m` server fetches use `MINIO_ENDPOINT`;
- no Docker host appears in browser-visible media URLs;
- video Range requests and `206` responses remain streaming;
- there are no unrelated edits or uncommitted files.

- [ ] **Step 5: Request code review and address only verified findings**

Use `superpowers:requesting-code-review` against `f7b489c..HEAD`. Re-run the focused tests and checks after any review-driven correction. Do not fold unrelated ComfyUI mapping work into this branch.

- [ ] **Step 6: Hand off the verified branch**

Use `superpowers:finishing-a-development-branch` to offer merge/push/PR choices. Report exact test counts and any proven pre-existing baseline failures; do not claim live Docker playback verification unless the app and MinIO containers were actually exercised.
