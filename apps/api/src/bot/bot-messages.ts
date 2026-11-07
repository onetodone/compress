import {
  describeInputLimits,
  fileFormats,
  type FileType,
  formatBytes,
  type InputLimits,
  type JobSummary,
  type Quota,
} from '@onetodone/compress-shared'

import { jobExpiresAt, RESULT_LIFETIME_MS } from '../common/jobs/job-lifetime.js'
import { encodeCallback } from './callback-data.js'
import type { InlineButton, InlineKeyboard } from './chat-gateway.js'

/** Jobs shown on one page of `/my_images`. */
export const IMAGES_PAGE_SIZE = 5

/** Reaction the bot puts on a file while it is being compressed. */
export const WORKING_REACTION = '👀'

/** Commands shown in the Telegram menu. */
export const BOT_COMMANDS = [
  { command: 'my_images', description: 'Your files of the last 7 days' },
  { command: 'quota', description: 'Files left today' },
  { command: 'login', description: 'Sign in on the website' },
  { command: 'unlink', description: 'Disconnect from the website account' },
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
  /** Largest file by MIME type, for every type the user may send. */
  inputLimits: InputLimits
}

/** Names the accepted formats for running text, e.g. `JPEG and PNG images and PDF documents`. */
function formatsText(types: readonly FileType[]): string {
  const images = types.filter((type) => fileFormats.info(type).kind === 'image')
  const documents = types.filter((type) => fileFormats.info(type).kind === 'document')
  return [
    ...(images.length > 0 ? [`${fileFormats.names('and', images)} images`] : []),
    ...(documents.length > 0 ? [`${fileFormats.names('and', documents)} documents`] : []),
  ].join(' and ')
}

function acceptedTypes(inputLimits: InputLimits): FileType[] {
  return fileFormats.types.filter((type) => inputLimits[type] !== undefined)
}

/**
 * Answer to `/start`.
 * @param inputLimits largest file by MIME type, for every type the user may send
 */
export function startText(inputLimits: InputLimits): string {
  const types = acceptedTypes(inputLimits)
  const documents = types.filter((type) => fileFormats.info(type).kind === 'document')
  const what = documents.length > 0 ? `an image or a ${fileFormats.names('or', documents)}` : 'an image'
  return [
    `Hi! I make ${formatsText(types)} smaller without visible loss of quality.`,
    '',
    `Send me ${what} as a file (📎 → File) and I will send the compressed file back.`,
    '',
    `/my_images — your files of the last ${LIFETIME_DAYS} days`,
    '/quota — files left today',
    '/login — sign in on the website with this Telegram account',
    '/help — how it works',
  ].join('\n')
}

/** Answer to `/help`. */
export function helpText({ dailyJobs, inputLimits }: LimitsInfo): string {
  return [
    'How it works:',
    '• Send an image as a file, not as a photo: Telegram recompresses photos and they lose quality. You can send several files at once.',
    `• ${describeInputLimits(inputLimits)}.`,
    '• The result keeps the format of the original. If a file cannot be made smaller, you get the original back.',
    `• Up to ${dailyJobs} files per day; the day starts at 00:00 UTC. Files that fail do not count.`,
    '',
    `/my_images lists your files of the last ${LIFETIME_DAYS} days, to download or delete them. Files are deleted automatically after ${LIFETIME_DAYS} days.`,
    'Deleting a file removes it from the service; files already sent to this chat stay here.',
    '',
    'The website and this bot share one account: /login signs you in on the website, and "Connect Telegram" on the website links this chat to an account you already have there. /unlink disconnects them again.',
  ].join('\n')
}

/** Answer to `/quota`. */
export function quotaText(quota: Quota, inputLimits: InputLimits, now: Date): string {
  const left = Math.max(quota.limit - quota.used, 0)
  return [
    `Today you have used ${quota.used} of ${quota.limit} files; ${left} left.`,
    `The limit resets at 00:00 UTC, in ${untilNextUtcDay(now)}.`,
    `Files: ${describeInputLimits(inputLimits)}.`,
  ].join('\n')
}

/** Reply to a file sent after the daily limit is used up. */
export function dailyLimitText(limit: number, now: Date): string {
  return `You have used all ${limit} files for today. The limit resets at 00:00 UTC, in ${untilNextUtcDay(now)}.`
}

/** Reply to an image sent as a photo. */
export const PHOTO_TEXT =
  'Please send the image as a file (📎 → File) to keep its quality: Telegram recompresses images sent as photos.'

/** Reply to plain text. */
export const TEXT_HINT = 'Send me a file to compress it. /help explains how.'

/** Reply to an unexpected failure. */
export const GENERIC_ERROR = 'Something went wrong. Please try again later.'

/**
 * Reply to a file of a type the service does not compress.
 * @param inputLimits largest file by MIME type, for every type the user may send
 */
export function unsupportedText(inputLimits: InputLimits): string {
  return `I can only compress ${formatsText(acceptedTypes(inputLimits))}. Send one as a file.`
}

/** Reply to a file above the user's size limit for its type. */
export function tooLargeText(type: FileType, maxBytes: number): string {
  return `The file is too large: ${fileFormats.info(type).name} files can be at most ${formatBytes(maxBytes)}.`
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
  const reason = (job.error ?? 'The file could not be processed').replace(/\.?$/, '.')
  const quota = quotaRefunded ? ' It does not count against your daily limit.' : ''
  return `Could not compress ${job.originalName}. ${reason}${quota}`
}

/**
 * The `/my_images` message for one page.
 * @param page 0-based page shown
 * @param total jobs the user has
 */
export function imagesPage(jobs: JobSummary[], page: number, total: number, quota: Quota, now: Date): BotMessage {
  const usage = `Today: ${quota.used} of ${quota.limit} files used.`
  if (total === 0) {
    return { text: `You have no files yet. Send me a file to compress it.\n\n${usage}` }
  }

  const pages = pageCount(total)
  const first = page * IMAGES_PAGE_SIZE + 1
  const header = `Your files: ${total}${pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}\n${usage}`
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
      return `Failed: ${job.error ?? 'the file could not be processed.'}`
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

/** Reply to a website link whose code is unknown, used or expired. */
export const LINK_EXPIRED_TEXT =
  'This link has expired or was already used. Open "Connect Telegram" on the website again for a new one.'

/** Reply when this Telegram account was connected to a website account. */
export const LINKED_TEXT =
  'Done: this Telegram account is connected to your website account. Files you send here appear on the website too, and the daily limit is shared.'

/**
 * Reply when this Telegram account was connected to a website account and its earlier files moved there.
 * @param movedJobs files that moved
 */
export function linkedWithImagesText(movedJobs: number): string {
  const files = movedJobs === 1 ? '1 file' : `${movedJobs} files`
  return `${LINKED_TEXT} The ${files} you sent here before moved there as well.`
}

/** Reply when this Telegram account was already connected to that website account. */
export const ALREADY_LINKED_TEXT = 'This Telegram account is already connected to that website account.'

/**
 * Question before this Telegram account is connected to a website account.
 * @param label how to name the website account, e.g. its email
 * @param images jobs of the account the Telegram account leaves
 * @param imagesMove whether those jobs move along; they stay with an account that has Google
 */
export function linkQuestion(label: string | null, images: number, imagesMove: boolean, code: string): BotMessage {
  const count = `${images} ${images === 1 ? 'file' : 'files'}`
  const lines = [
    label
      ? `Connect this Telegram account to the website account ${label}?`
      : 'Connect this Telegram account to the website account?',
    'Files you send here will appear on the website, and the daily limit is shared. Only connect your own account.',
  ]
  if (images > 0) {
    lines.push(
      '',
      imagesMove
        ? `The ${count} you have here ${images === 1 ? 'moves' : 'move'} to that account too.`
        : `The ${count} you have here ${images === 1 ? 'stays' : 'stay'} with the current account, which you can still reach with Google on the website.`,
    )
  }
  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: 'Connect', data: encodeCallback({ type: 'link', code }) },
        { text: 'Cancel', data: encodeCallback({ type: 'cancel' }) },
      ],
    ],
  }
}

/** Reply to `/login` when the bot does not know the website's address. */
export const LOGIN_UNAVAILABLE_TEXT = 'Signing in on the website is not available right now.'

/**
 * Answer to `/login`: a one-time link that signs in on the website. Telegram accepts only HTTPS
 * links on buttons, so other addresses (local development) are given as text only.
 */
export function loginMessage(url: string, validMinutes: number): BotMessage {
  const text = [
    'Open this link to sign in on the website with this Telegram account. It works once, within ' +
      `${validMinutes} minutes. Do not share it: whoever opens it gets into your account.`,
    '',
    url,
  ].join('\n')
  if (!url.startsWith('https://')) return { text }
  return { text, keyboard: [[{ text: 'Sign in on the website', url }]] }
}

/** Reply to `/unlink` when Telegram is the only way into the account. */
export const UNLINK_REFUSED_TEXT =
  'This Telegram account is the only way to sign in to your account, so it cannot be disconnected. Sign in on the website with /login and link Google there first.'

/** Question before this Telegram account is disconnected from its account. */
export function unlinkQuestion(): BotMessage {
  return {
    text: [
      'Disconnect this Telegram account from your account?',
      'Your files stay with the account and remain available on the website when you sign in with Google. Files you send here afterwards go to a new, separate account.',
    ].join('\n'),
    keyboard: [
      [
        { text: 'Disconnect', data: encodeCallback({ type: 'unlink' }) },
        { text: 'Cancel', data: encodeCallback({ type: 'cancel' }) },
      ],
    ],
  }
}

/** Reply when this Telegram account was disconnected. */
export const UNLINKED_TEXT =
  'Disconnected. Files you send now go to a new, separate account; the earlier ones stay available on the website.'

/** Reply to a cancelled question. */
export const CANCELLED_TEXT = 'Cancelled.'
