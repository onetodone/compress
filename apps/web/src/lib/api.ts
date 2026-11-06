import {
  type CreateJobRequest,
  type CreateJobResponse,
  createJobResponseSchema,
  type DownloadJobQuery,
  type DownloadJobResponse,
  downloadJobResponseSchema,
  type ListJobsResponse,
  listJobsResponseSchema,
  type MeResponse,
  meResponseSchema,
  type SubmitJobResponse,
  submitJobResponseSchema,
} from '@onetodone/image-compressor-shared'
import { z } from 'zod'

import { ApiError, apiError, apiErrorMessage } from './api-error'
import { env } from './env'
import { getFirebase } from './firebase'

async function request<S extends z.ZodType>(path: string, schema: S, init: RequestInit = {}): Promise<z.output<S>> {
  const { auth } = getFirebase()
  await auth.authStateReady()
  const user = auth.currentUser
  if (!user) throw new ApiError(401, apiErrorMessage(401, undefined))

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await user.getIdToken()}`)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')

  let response: Response
  try {
    response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.')
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw apiError(response.status, body)
  return schema.parse(body)
}

/** Calls of the public HTTP API, authenticated with the current user's Firebase ID token. */
export const api = {
  /** Returns the current user and today's quota as the API sees them. */
  me(): Promise<MeResponse> {
    return request('/me', meResponseSchema)
  },

  /** Creates a job and returns a presigned URL for uploading its file. */
  createJob(body: CreateJobRequest): Promise<CreateJobResponse> {
    return request('/jobs', createJobResponseSchema, { method: 'POST', body: JSON.stringify(body) })
  },

  /** Confirms the upload of a job and queues it for compression. */
  submitJob(jobId: string): Promise<SubmitJobResponse> {
    return request(`/jobs/${encodeURIComponent(jobId)}/submit`, submitJobResponseSchema, { method: 'POST' })
  },

  /** Returns a page of the user's jobs, newest first. */
  listJobs(cursor: string | null): Promise<ListJobsResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return request(`/jobs${query}`, listJobsResponseSchema)
  },

  /**
   * Returns a short-lived URL of the compressed file of a finished job.
   * @param disposition `attachment` saves the file, `inline` lets an `<img>` display it
   */
  downloadJob(
    jobId: string,
    disposition: DownloadJobQuery['disposition'] = 'attachment',
  ): Promise<DownloadJobResponse> {
    return request(`/jobs/${encodeURIComponent(jobId)}/download?disposition=${disposition}`, downloadJobResponseSchema)
  },

  /** Deletes a job together with its files. */
  async deleteJob(jobId: string): Promise<void> {
    await request(`/jobs/${encodeURIComponent(jobId)}`, z.undefined(), { method: 'DELETE' })
  },
}
