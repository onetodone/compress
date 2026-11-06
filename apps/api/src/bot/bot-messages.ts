import { formatBytes, imageFormats, type JobSummary, type Quota } from '@onetodone/image-compressor-shared'

import { jobExpiresAt, RESULT_LIFETIME_MS } from '../common/jobs/job-lifetime.js'
import { encodeCallback } from './callback-data.js'
import type { InlineButton, InlineKeyboard } from './chat-gateway.js'

/** Jobs shown on one page of `/my_images`. */
export const IMAGES_PAGE_SIZE = 5

/** Reaction the bot puts on a file while it is being compressed. */
export const WORKING_REACTION = '👀'

/** Commands shown in the Telegram menu. */
export const BOT_COMMANDS = [
  { command: 'my_images', description: 'Your images of the last 7 days' },
  { command: 'quota', description: 'Images left today' },
  { command: 'help', description: 'How it works' },
  { command: 'start', description: 'Start the bot' },
] as const

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LIFETIME_DAYS = Math.round(RESULT_LIFETIME_MS / DAY_MS)
const BUTTON_NAME_LENGTH = 24

/** A message text with optional buttons. */
export interface BotMessage {
  text: string
  keyboard?: InlineKeyboard
}

/** Limits of the user that the texts mention. */
export interface LimitsInfo {
  dailyJobs: number
  maxInputBytes: number
}

const formats = () => imageFormats.names('and')

/** Answer to `/start`. */
export function startText(): string {
  return [
    `Hi! I make ${formats()} images smaller without visible loss of quality.`,
    '',
    'Send me an image as a file (📎 → File) and I will send the compressed file back.',
    '',
    `/my_images — your images of the last ${LIFETIME_DAYS} days`,
    '/quota — images left today',
    '/help — how it works',
  ].join('\n')
}

/** Answer to `/help`. */
export function helpText({ dailyJobs, maxInputBytes }: LimitsInfo): string {
  return [
    'How it works:',
    '• Send an image as a file, not as a photo: Telegram recompresses photos and they lose quality. You can send several files at once.',
    `• ${formats()} images up to ${formatBytes(maxInputBytes)} each.`,
    '• The result keeps the format of the original. If an image cannot be made smaller, you get the original back.',
    `• Up to ${dailyJobs} images per day; the day starts at 00:00 UTC. Images that fail do not count.`,
    '',
    `/my_images lists your images of the last ${LIFETIME_DAYS} days, to download or delete them. Images are deleted automatically after ${LIFETIME_DAYS} days.`,
    'Deleting an image removes it from the service; files already sent to this chat stay here.',
  ].join('\n')
}

/** Answer to `/quota`. */
export function quotaText(quota: Quota, maxInputBytes: number, now: Date): string {
  const left = Math.max(quota.limit - quota.used, 0)
  return [
    `Today you have used ${quota.used} of ${quota.limit} images; ${left} left.`,
    `The limit resets at 00:00 UTC, in ${untilNextUtcDay(now)}.`,
    `Files up to ${formatBytes(maxInputBytes)}: ${imageFormats.names('or')}.`,
  ].join('\n')
}

/** Reply to a file sent after the daily limit is used up. */
export function dailyLimitText(limit: number, now: Date): string {
  return `You have used all ${limit} images for today. The limit resets at 00:00 UTC, in ${untilNextUtcDay(now)}.`
}

/** Reply to an image sent as a photo. */
export const PHOTO_TEXT =
  'Please send the image as a file (📎 → File) to keep its quality: Telegram recompresses images sent as photos.'

/** Reply to plain text. */
export const TEXT_HINT = 'Send me an image as a file to compress it. /help explains how.'

/** Reply to an unexpected failure. */
export const GENERIC_ERROR = 'Something went wrong. Please try again later.'

/** Reply to a file of a type the service does not compress. */
export function unsupportedText(): string {
  return `I can only compress ${imageFormats.names('and')} images. Send one as a file.`
}

/** Reply to a file above the user's size limit. */
export function tooLargeText(maxInputBytes: number): string {
  return `The file is too large: images can be at most ${formatBytes(maxInputBytes)}.`
}

/** Caption of a compressed result. */
export function resultCaption(job: JobSummary): string {
  const { inputBytes, outputBytes } = job
  if (inputBytes === null || outputBytes === null) return job.originalName
  if (outputBytes >= inputBytes) {
    return `${job.originalName} is already well compressed, so here is the original (${formatBytes(inputBytes)}).`
  }
  return `${job.originalName}: ${formatBytes(inputBytes)} → ${formatBytes(outputBytes)}, ${savedText(inputBytes, outputBytes)}`
}

/** Reply to a file whose job failed. */
export function failureText(job: JobSummary, quotaRefunded: boolean): string {
  const reason = (job.error ?? 'The image could not be processed').replace(/\.?$/, '.')
  const quota = quotaRefunded ? ' It does not count against your daily limit.' : ''
  return `Could not compress ${job.originalName}. ${reason}${quota}`
}

/**
 * The `/my_images` message for one page.
 * @param page 0-based page shown
 * @param total jobs the user has
 */
export function imagesPage(jobs: JobSummary[], page: number, total: number, quota: Quota, now: Date): BotMessage {
  const usage = `Today: ${quota.used} of ${quota.limit} images used.`
  if (total === 0) {
    return { text: `You have no images yet. Send me an image as a file to compress it.\n\n${usage}` }
  }

  const pages = pageCount(total)
  const first = page * IMAGES_PAGE_SIZE + 1
  const header = `Your images: ${total}${pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}\n${usage}`
  const entries = jobs.map((job, index) => `${first + index}. ${job.originalName}\n${jobLine(job, now)}`)

  const rows: InlineKeyboard = jobs.map((job, index) => {
    const label = `${first + index}. ${shorten(job.originalName)}`
    const remove = { text: '🗑', data: encodeCallback({ type: 'askDelete', jobId: job.id, page }) }
    if (job.status !== 'done') return [{ ...remove, text: `🗑 ${label}` }]
    return [{ text: `⬇ ${label}`, data: encodeCallback({ type: 'download', jobId: job.id }) }, remove]
  })
  const navigation: InlineButton[] = []
  if (page > 0) navigation.push({ text: '‹ Newer', data: encodeCallback({ type: 'page', page: page - 1 }) })
  navigation.push({ text: '↻ Refresh', data: encodeCallback({ type: 'page', page }) })
  if (page < pages - 1) navigation.push({ text: 'Older ›', data: encodeCallback({ type: 'page', page: page + 1 }) })

  return { text: [header, ...entries].join('\n\n'), keyboard: [...rows, navigation] }
}

/** Number of `/my_images` pages for a number of jobs, at least one. */
export function pageCount(total: number): number {
  return Math.max(Math.ceil(total / IMAGES_PAGE_SIZE), 1)
}

/** Question shown in place of the list before a job is deleted. */
export function deleteQuestion(job: JobSummary, page: number): BotMessage {
  return {
    text: `Delete ${job.originalName}?\nIt is removed from the service; files already sent to this chat stay here.`,
    keyboard: [
      [
        { text: '🗑 Delete', data: encodeCallback({ type: 'delete', jobId: job.id, page }) },
        { text: 'Cancel', data: encodeCallback({ type: 'page', page }) },
      ],
    ],
  }
}

function jobLine(job: JobSummary, now: Date): string {
  switch (job.status) {
    case 'awaiting_upload':
      return 'Uploading…'
    case 'queued':
      return 'Waiting to be compressed…'
    case 'processing':
      return 'Compressing…'
    case 'failed':
      return `Failed: ${job.error ?? 'the image could not be processed.'}`
    case 'done':
      return `${sizes(job)} · ${timeLeft(jobExpiresAt(new Date(job.createdAt)), now)}`
    case 'unknown':
      return 'Status unknown'
  }
}

function sizes({ inputBytes, outputBytes }: JobSummary): string {
  if (inputBytes === null || outputBytes === null) return 'Compressed'
  if (outputBytes >= inputBytes) return `${formatBytes(inputBytes)}, already well compressed`
  return `${formatBytes(inputBytes)} → ${formatBytes(outputBytes)}, ${savedText(inputBytes, outputBytes)}`
}

function savedText(inputBytes: number, outputBytes: number): string {
  const percent = Math.round((1 - outputBytes / inputBytes) * 100)
  return percent < 1 ? 'less than 1% smaller' : `${percent}% smaller`
}

function timeLeft(expiresAt: Date, now: Date): string {
  const ms = expiresAt.getTime() - now.getTime()
  if (ms < HOUR_MS) return 'deleted within the hour'
  if (ms < DAY_MS) return `deleted in ${Math.floor(ms / HOUR_MS)} h`
  const days = Math.floor(ms / DAY_MS)
  return `${days} ${days === 1 ? 'day' : 'days'} left`
}

function untilNextUtcDay(now: Date): string {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  const minutes = Math.ceil((next - now.getTime()) / MINUTE_MS)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function shorten(name: string): string {
  return name.length <= BUTTON_NAME_LENGTH ? name : `${name.slice(0, BUTTON_NAME_LENGTH - 1)}…`
}
