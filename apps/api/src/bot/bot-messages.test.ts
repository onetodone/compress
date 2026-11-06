import type { JobSummary, Quota } from '@onetodone/image-compressor-shared'
import { describe, expect, it } from 'vitest'

import { JOB_LIFETIME_MS } from '../common/jobs/job-lifetime.js'
import {
  failureText,
  helpText,
  imagesPage,
  linkQuestion,
  loginMessage,
  quotaText,
  resultCaption,
} from './bot-messages.js'
import { parseCallback } from './callback-data.js'
import type { InlineButton } from './chat-gateway.js'

const dataOf = (button: InlineButton) => ('data' in button ? button.data : '')

const NOW = new Date('2026-11-06T18:30:00Z')
const quota: Quota = { dayKey: '2026-11-06', used: 3, limit: 30 }

function job(fields: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'a1B2c3D4e5F6g7H8i9J0',
    status: 'done',
    originalName: 'photo.jpg',
    inputType: 'image/jpeg',
    outputType: 'image/jpeg',
    inputBytes: 2 * 1024 * 1024,
    outputBytes: 512 * 1024,
    width: 100,
    height: 100,
    previewUrl: null,
    error: null,
    createdAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    ...fields,
  }
}

describe('bot messages', () => {
  it('describes the limits of the user in the help', () => {
    const text = helpText({ dailyJobs: 30, maxInputBytes: 10 * 1024 * 1024 })

    expect(text).toContain('JPEG, PNG, WebP and AVIF images up to 10 MB each.')
    expect(text).toContain('Up to 30 images per day')
    expect(text).toContain('files already sent to this chat stay here')
  })

  it('tells the quota left and when it resets', () => {
    expect(quotaText(quota, 10 * 1024 * 1024, NOW)).toBe(
      [
        'Today you have used 3 of 30 images; 27 left.',
        'The limit resets at 00:00 UTC, in 5 h 30 min.',
        'Files up to 10 MB: JPEG, PNG, WebP or AVIF.',
      ].join('\n'),
    )
  })

  it('captions a result with its sizes, or says the original is returned', () => {
    expect(resultCaption(job())).toBe('photo.jpg: 2.0 MB → 512 KB, 75% smaller')
    expect(resultCaption(job({ outputBytes: 2 * 1024 * 1024 }))).toBe(
      'photo.jpg is already well compressed, so here is the original (2.0 MB).',
    )
  })

  it('explains a failure and whether it counts against the limit', () => {
    const failed = job({ status: 'failed', error: 'The file is not a valid image' })

    expect(failureText(failed, true)).toBe(
      'Could not compress photo.jpg. The file is not a valid image. It does not count against your daily limit.',
    )
    expect(failureText(failed, false)).toBe('Could not compress photo.jpg. The file is not a valid image.')
  })

  describe('account links', () => {
    it('puts an HTTPS login link on a button', () => {
      const url = 'https://img.example.com/#telegram-login=Ab-_0123456789abcdefgh'
      const { text, keyboard } = loginMessage(url, 10)

      expect(text).toContain(url)
      expect(text).toContain('within 10 minutes')
      expect(keyboard).toEqual([[{ text: 'Sign in on the website', url }]])
    })

    it('gives a login link that Telegram would refuse on a button as text only', () => {
      const url = 'http://localhost:3000/#telegram-login=Ab-_0123456789abcdefgh'

      expect(loginMessage(url, 10)).toEqual({ text: expect.stringContaining(url) as string })
    })

    it('names the website account and mentions images left behind', () => {
      const code = 'Ab-_0123456789abcdefgh'
      const { text, keyboard } = linkQuestion('ada@example.com', 1, code)

      expect(text).toContain('to the website account ada@example.com?')
      expect(text).toContain('The 1 image you have here stay')
      expect(parseCallback(dataOf(keyboard![0]![0]!))).toEqual({ type: 'link', code })
      expect(parseCallback(dataOf(keyboard![0]![1]!))).toEqual({ type: 'cancel' })
    })
  })

  describe('images page', () => {
    it('numbers jobs across pages and offers downloads only for finished ones', () => {
      const jobs = [job(), job({ id: 'b1B2c3D4e5F6g7H8i9J0', status: 'processing', originalName: 'scan.png' })]

      const { text, keyboard } = imagesPage(jobs, 1, 7, quota, NOW)

      expect(text).toBe(
        [
          'Your images: 7 · page 2 of 2\nToday: 3 of 30 images used.',
          '6. photo.jpg\n2.0 MB → 512 KB, 75% smaller · 6 days left',
          '7. scan.png\nCompressing…',
        ].join('\n\n'),
      )
      expect(keyboard?.map((row) => row.map((button) => button.text))).toEqual([
        ['⬇ 6. photo.jpg', '🗑'],
        ['🗑 7. scan.png'],
        ['‹ Newer', '↻ Refresh'],
      ])
      expect(parseCallback(dataOf(keyboard![0]![0]!))).toEqual({ type: 'download', jobId: jobs[0]!.id })
      expect(parseCallback(dataOf(keyboard![1]![0]!))).toEqual({ type: 'askDelete', jobId: jobs[1]!.id, page: 1 })
    })

    it('counts down the hours of a result about to be deleted', () => {
      const createdAt = new Date(NOW.getTime() - JOB_LIFETIME_MS + 5.5 * 60 * 60_000).toISOString()

      expect(imagesPage([job({ createdAt })], 0, 1, quota, NOW).text).toContain('· deleted in 5 h')
    })

    it('shortens long names on buttons', () => {
      const { keyboard } = imagesPage(
        [job({ originalName: 'a-very-long-name-of-a-holiday-photo.jpg' })],
        0,
        1,
        quota,
        NOW,
      )

      expect(keyboard?.[0]?.[0]?.text).toBe('⬇ 1. a-very-long-name-of-a-h…')
    })
  })
})
