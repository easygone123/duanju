const DIRECTOR_UPLOAD_ROOT = 'novel-promotion/director'

export function directorUploadPrefix(userId: string, projectId: string) {
  return `${DIRECTOR_UPLOAD_ROOT}/${userId}/${projectId}/`
}

export function isOwnedDirectorUploadStorageKey(
  storageKey: string,
  userId: string,
  projectId: string,
) {
  return storageKey.startsWith(directorUploadPrefix(userId, projectId))
}
