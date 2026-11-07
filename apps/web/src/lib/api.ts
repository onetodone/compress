import {
  type CreateLinkCodeResponse,
  createLinkCodeResponseSchema,
  type CreateJobRequest,
  type CreateJobResponse,
  createJobResponseSchema,
  type DownloadJobQuery,
  type DownloadJobResponse,
  downloadJobResponseSchema,
  type ListJobsResponse,
  listJobsResponseSchema,
  type MergeSessionResponse,
  mergeSessionResponseSchema,
  type MeResponse,
  meResponseSchema,
  type SubmitJobResponse,
  submitJobResponseSchema,
  type TelegramLoginResponse,
  telegramLoginResponseSchema,
} from '@onetodone/compress-shared'
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
  return send(path, schema, { ...init, headers })
}

async function send<S extends z.ZodType>(path: string, schema: S, init: RequestInit = {}): Promise<z.output<S>> {
  const headers = new Headers(init.headers)
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

  /** Creates a one-time Telegram link that connects the Telegram account opening it to this user. */
  createTelegramLinkCode(): Promise<CreateLinkCodeResponse> {
    return request('/auth/telegram/link-code', createLinkCodeResponseSchema, { method: 'POST' })
  },

  /** Exchanges a login code from the Telegram bot for a Firebase custom token; needs no session. */
  telegramLogin(code: string): Promise<TelegramLoginResponse> {
    return send('/auth/telegram', telegramLoginResponseSchema, { method: 'POST', body: JSON.stringify({ code }) })
  },

  /**
   * Moves the images and today's used quota of an anonymous session the user just left into the
   * signed-in user.
   * @param anonymousToken Firebase ID token of that anonymous session
   */
  mergeAnonymousSession(anonymousToken: string): Promise<MergeSessionResponse> {
    return request('/me/merge', mergeSessionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ anonymousToken }),
    })
  },

  /** Disconnects the linked Telegram account; the user needs Google to sign in afterwards. */
  async unlinkTelegram(): Promise<void> {
    await request('/auth/telegram', z.undefined(), { method: 'DELETE' })
  },
}
