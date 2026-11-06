import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { AuthUser } from '../../common/auth/auth-user.js'
import type { AuthenticatedRequest } from './auth-user.js'

/** Injects the authenticated user into a route handler parameter. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>()
  if (!user) throw new Error('CurrentUser used on a route without authentication')
  return user
})

/** Injects whether the authenticated user has a Google sign-in, according to the verified ID token. */
export const GoogleLinked = createParamDecorator((_data: unknown, context: ExecutionContext): boolean => {
  const { linkedProviders } = context.switchToHttp().getRequest<AuthenticatedRequest>()
  return linkedProviders?.includes('google.com') ?? false
})
