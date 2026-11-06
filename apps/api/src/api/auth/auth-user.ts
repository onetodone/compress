import type { Request } from 'express'

import type { AuthUser } from '../../common/auth/auth-user.js'

/** A request that passed the auth guard carries the user from its verified Firebase ID token. */
export type AuthenticatedRequest = Request & { user?: AuthUser }
