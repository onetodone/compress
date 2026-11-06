import { Controller, Get, Inject, Ip } from '@nestjs/common'
import type { MeResponse } from '@onetodone/compress-shared'

import { AccountLinkService } from '../../common/accounts/account-link.service.js'
import type { AuthUser } from '../../common/auth/auth-user.js'
import type { ApiConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { QuotaService } from '../../common/quota/quota.service.js'
import { CurrentUser, GoogleLinked } from '../auth/current-user.decorator.js'

@Controller('me')
export class MeController {
  constructor(
    private readonly quota: QuotaService,
    private readonly accounts: AccountLinkService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async me(
    @CurrentUser() user: AuthUser,
    @GoogleLinked() googleLinked: boolean,
    @Ip() ip: string | undefined,
  ): Promise<MeResponse> {
    const [quota, networkLimitReached, telegram] = await Promise.all([
      this.quota.get(user),
      this.quota.networkLimitReached(user, ip),
      this.accounts.status(user, googleLinked),
    ])
    return {
      uid: user.uid,
      kind: user.kind,
      isAnonymous: user.kind === 'anonymous',
      quota,
      limits: { maxInputBytes: this.quota.entitlements(user).maxInputBytes },
      networkLimitReached,
      telegram: this.config.TELEGRAM_BOT_USERNAME ? telegram : null,
    }
  }
}
