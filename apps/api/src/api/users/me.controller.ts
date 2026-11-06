import { Controller, Get, Ip } from '@nestjs/common'
import type { MeResponse } from '@onetodone/image-compressor-shared'

import type { AuthUser } from '../../common/auth/auth-user.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { QuotaService } from '../../common/quota/quota.service.js'

@Controller('me')
export class MeController {
  constructor(private readonly quota: QuotaService) {}

  @Get()
  async me(@CurrentUser() user: AuthUser, @Ip() ip: string | undefined): Promise<MeResponse> {
    const [quota, networkLimitReached] = await Promise.all([
      this.quota.get(user),
      this.quota.networkLimitReached(user, ip),
    ])
    return {
      uid: user.uid,
      kind: user.kind,
      isAnonymous: user.kind === 'anonymous',
      quota,
      limits: { maxInputBytes: this.quota.entitlements(user).maxInputBytes },
      networkLimitReached,
    }
  }
}
