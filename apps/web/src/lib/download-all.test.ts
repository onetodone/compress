import type { JobSummary } from '@onetodone/compress-shared'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { archiveResults, type ResultSource } from './download-all'

function job(id: string, originalName: string, outputType: string | null = 'image/jpeg'): JobSummary {
  return {
    id,
    status: 'done',
    originalName,
    inputType: 'image/jpeg',
    outputType,
    inputBytes: 100,
    outputBytes: 50,
    width: 10,
    height: 10,
    previewUrl: null,
    error: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    finishedAt: '2026-11-06T10:00:05.000Z',
  }
}

function source(failing: readonly string[] = []): ResultSource {
  return {
    resultUrl: vi.fn(async (jobId: string) => `https://r2.test/${jobId}`),
    fetchBytes: vi.fn(async (url: string) => {
      const jobId = url.split('/').at(-1)!
      if (failing.includes(jobId)) throw new Error('403')
      return strToU8(`bytes of ${jobId}`)
    }),
  }
}

describe('archiveResults', () => {
  it('packs every result under its download name, with repeated names numbered', async () => {
    const jobs = [
      job('j1', 'holiday.JPEG'),
      job('j2', 'holiday.jpg'),
      job('j3', 'scan.jpg', 'image/png'),
      job('j4', 'icon.webp', null),
      job('j5', 'future.heic', 'image/heic'),
    ]
    jobs[3]!.inputType = 'image/webp'
    const progress: number[] = []
    const { zip, failed } = await archiveResults(jobs, source(), (handled) => progress.push(handled))

    const files = unzipSync(zip!)
    expect(Object.keys(files)).toEqual(['holiday.jpg', 'holiday (2).jpg', 'scan.png', 'icon.webp', 'future.heic'])
    expect(strFromU8(files['holiday (2).jpg']!)).toBe('bytes of j2')
    expect(failed).toBe(0)
    expect(progress.at(-1)).toBe(5)
  })

  it('leaves out results that cannot be fetched and counts them', async () => {
    const { zip, failed } = await archiveResults([job('j1', 'a.jpg'), job('j2', 'b.jpg')], source(['j2']))
    expect(Object.keys(unzipSync(zip!))).toEqual(['a.jpg'])
    expect(failed).toBe(1)
  })

  it('returns no archive when nothing could be fetched', async () => {
    expect(await archiveResults([job('j1', 'a.jpg')], source(['j1']))).toEqual({ zip: null, failed: 1 })
  })
})
