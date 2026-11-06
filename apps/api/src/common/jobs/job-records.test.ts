import { describe, expect, it } from 'vitest'

import { awaitsChatAnswer, readChatTarget } from './job-records.js'

const notify = { chatId: -100, messageId: 7 }

describe('chat targets of jobs', () => {
  it('reads the message a job came from and ignores web jobs and unreadable values', () => {
    expect(readChatTarget({ notify })).toEqual(notify)
    expect(readChatTarget({ notify: null })).toBeNull()
    expect(readChatTarget({})).toBeNull()
    expect(readChatTarget({ notify: { chatId: '1', messageId: 7 } })).toBeNull()
    expect(readChatTarget(undefined)).toBeNull()
  })

  it('waits for an answer only for finished chat jobs not answered yet', () => {
    expect(awaitsChatAnswer({ notify, status: 'done' })).toBe(true)
    expect(awaitsChatAnswer({ notify, status: 'failed' })).toBe(true)
    expect(awaitsChatAnswer({ notify, status: 'processing' })).toBe(false)
    expect(awaitsChatAnswer({ notify, status: 'done', notifiedAt: new Date() })).toBe(false)
    expect(awaitsChatAnswer({ notify: null, status: 'done' })).toBe(false)
  })
})
