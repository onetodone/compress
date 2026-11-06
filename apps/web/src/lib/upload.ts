/** A failed upload to R2; `message` is safe to show to the user. */
export class UploadError extends Error {
  override name = 'UploadError'
}

/**
 * Uploads a file to a presigned URL with `PUT`, reporting progress. `fetch` cannot report upload
 * progress, hence `XMLHttpRequest`.
 * @param url presigned upload URL
 * @param file file to send
 * @param contentType type the URL was signed with
 * @param onProgress receives the uploaded fraction from 0 to 1
 */
export function uploadFile(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new UploadError('The upload was rejected. Try again.'))
    }
    xhr.onerror = () => reject(new UploadError('The upload failed. Check your connection.'))
    xhr.send(file)
  })
}
