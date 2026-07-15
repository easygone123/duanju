export async function cleanupUploadTempFile(
  cleanup: () => Promise<void>,
  preserveExistingOutcome: boolean,
): Promise<void> {
  try {
    await cleanup()
  } catch (error: unknown) {
    if (!preserveExistingOutcome) throw error
  }
}
