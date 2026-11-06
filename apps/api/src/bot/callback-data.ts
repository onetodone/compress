import { jobIdSchema } from '@onetodone/image-compressor-shared'

/** What a button under a bot message asks for. Pages are 0-based. */
export type CallbackAction =
  | { type: 'page'; page: number }
  | { type: 'download'; jobId: string }
  | { type: 'askDelete'; jobId: string; page: number }
  | { type: 'delete'; jobId: string; page: number }

// Short prefixes keep the data within Telegram's 64 bytes.
const PREFIX = { page: 'p', download: 'd', askDelete: 'a', delete: 'x' } as const

const MAX_PAGE = 10_000

/** Encodes a button action as callback data (at most 64 bytes). */
export function encodeCallback(action: CallbackAction): string {
  switch (action.type) {
    case 'page':
      return `${PREFIX.page}:${action.page}`
    case 'download':
      return `${PREFIX.download}:${action.jobId}`
    case 'askDelete':
    case 'delete':
      return `${PREFIX[action.type]}:${action.jobId}:${action.page}`
  }
}

/**
 * Decodes callback data of a button. Returns `null` for data this version does not know, e.g. from
 * buttons of an older message.
 */
export function parseCallback(data: string): CallbackAction | null {
  const [prefix, first, second, ...rest] = data.split(':')
  if (rest.length > 0 || first === undefined) return null
  if (prefix === PREFIX.page) return second === undefined ? pageAction(first) : null
  if (!jobIdSchema.safeParse(first).success) return null
  if (prefix === PREFIX.download) return second === undefined ? { type: 'download', jobId: first } : null
  const page = second === undefined ? null : parsePage(second)
  if (page === null) return null
  if (prefix === PREFIX.askDelete) return { type: 'askDelete', jobId: first, page }
  if (prefix === PREFIX.delete) return { type: 'delete', jobId: first, page }
  return null
}

function pageAction(value: string): CallbackAction | null {
  const page = parsePage(value)
  return page === null ? null : { type: 'page', page }
}

function parsePage(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null
  const page = Number(value)
  return page <= MAX_PAGE ? page : null
}
