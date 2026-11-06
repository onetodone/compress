import { ImageCdn } from '../../src/common/cloudinary/image-cdn.js'
import {
  type DownloadOptions,
  ObjectStorage,
  type PresignedUrl,
  type StoredObject,
  type UploadConstraints,
} from '../../src/common/r2/object-storage.js'
import { NetworkQuota } from '../../src/api/users/network-quota.js'
import { TaskQueue } from '../../src/common/tasks/task-queue.js'

/** An object held by {@link InMemoryObjectStorage}. */
export interface InMemoryObject extends StoredObject {
  data: Buffer
}

/** {@link ObjectStorage} kept in memory; {@link upload} plays the client's `PUT` to a presigned URL. */
export class InMemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, InMemoryObject>()
  readonly presigned = new Map<string, UploadConstraints & { expiresInSeconds: number }>()
  /** Operations that fail as if R2 was unavailable, until removed. */
  readonly unavailable = new Set<'get' | 'put' | 'delete'>()

  presignUpload(key: string, constraints: UploadConstraints, expiresInSeconds: number): Promise<PresignedUrl> {
    this.presigned.set(key, { ...constraints, expiresInSeconds })
    const url = `https://storage.test/${key}?X-Amz-Signature=test`
    return Promise.resolve({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) })
  }

  presignDownload(key: string, options: DownloadOptions, expiresInSeconds: number): Promise<PresignedUrl> {
    const query = new URLSearchParams({
      'response-content-type': options.contentType,
      'response-content-disposition': options.contentDisposition,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-Signature': 'test',
    })
    const url = `https://storage.test/${key}?${query.toString()}`
    return Promise.resolve({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) })
  }

  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key)
    return Promise.resolve(object ? { size: object.size, contentType: object.contentType } : null)
  }

  get(key: string): Promise<Buffer | null> {
    if (this.unavailable.has('get')) return Promise.reject(new Error('R2 is unavailable'))
    return Promise.resolve(this.objects.get(key)?.data ?? null)
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.unavailable.has('put')) return Promise.reject(new Error('R2 is unavailable'))
    this.objects.set(key, { data: body, size: body.length, contentType })
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    if (this.unavailable.has('delete')) return Promise.reject(new Error('R2 is unavailable'))
    this.objects.delete(key)
    return Promise.resolve()
  }

  /**
   * Stores an object as if it was uploaded through the presigned URL, with the signed type and size
   * by default. Without `data`, the content is zero bytes of the stored size.
   */
  upload(key: string, object?: Partial<InMemoryObject>): void {
    const signed = this.presigned.get(key)
    const size = object?.data?.length ?? object?.size ?? signed?.contentLength ?? 1
    this.objects.set(key, { contentType: signed?.contentType, data: Buffer.alloc(size), size, ...object })
  }
}

/** {@link TaskQueue} that only records the jobs it was asked to enqueue; recorded tasks count as pending. */
export class RecordingTaskQueue extends TaskQueue {
  readonly enqueued: string[] = []

  enqueueCompression(jobId: string): Promise<void> {
    this.enqueued.push(jobId)
    return Promise.resolve()
  }

  hasPendingCompression(jobId: string): Promise<boolean> {
    return Promise.resolve(this.enqueued.includes(jobId))
  }
}

/** {@link ImageCdn} kept in memory, with preview URLs on a fake CDN host. */
export class InMemoryImageCdn extends ImageCdn {
  readonly assets = new Map<string, Buffer>()
  /** Operations that fail as if Cloudinary was unavailable, until removed. */
  readonly unavailable = new Set<'upload' | 'delete'>()
  /** Runs before each upload is stored, e.g. to change the job while the worker is busy. */
  beforeUpload: ((jobId: string) => Promise<void>) | null = null
  /** Behaves like a deployment without Cloudinary: nothing is stored and there is no preview URL. */
  disabled = false

  async upload(jobId: string, data: Buffer): Promise<string | null> {
    await this.beforeUpload?.(jobId)
    if (this.disabled) return null
    if (this.unavailable.has('upload')) throw new Error('Cloudinary is unavailable')
    this.assets.set(jobId, data)
    return `https://cdn.test/image/upload/c_limit,f_auto,q_auto,w_800/v1/test/${jobId}`
  }

  delete(jobId: string): Promise<void> {
    if (this.unavailable.has('delete')) return Promise.reject(new Error('Cloudinary is unavailable'))
    this.assets.delete(jobId)
    return Promise.resolve()
  }

  /** Forgets all assets and failure settings. */
  reset(): void {
    this.assets.clear()
    this.unavailable.clear()
    this.beforeUpload = null
    this.disabled = false
  }
}

/** {@link NetworkQuota} kept in memory, keyed by `{dayKey}:{network}`. */
export class InMemoryNetworkQuota extends NetworkQuota {
  readonly counters = new Map<string, number>()

  used(network: string, dayKey: string): Promise<number> {
    return Promise.resolve(this.counters.get(`${dayKey}:${network}`) ?? 0)
  }

  reserve(network: string, dayKey: string, limit: number): Promise<boolean> {
    const key = `${dayKey}:${network}`
    const used = this.counters.get(key) ?? 0
    if (used >= limit) return Promise.resolve(false)
    this.counters.set(key, used + 1)
    return Promise.resolve(true)
  }

  release(network: string, dayKey: string): Promise<void> {
    const key = `${dayKey}:${network}`
    this.counters.set(key, Math.max((this.counters.get(key) ?? 0) - 1, 0))
    return Promise.resolve()
  }
}
