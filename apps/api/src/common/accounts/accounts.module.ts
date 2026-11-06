import { Module } from '@nestjs/common'

import { AccountLinkService } from './account-link.service.js'
import { TelegramIdentityService } from './telegram-identity.service.js'

/** Telegram identities and the links between Telegram accounts and website users. */
@Module({
  providers: [TelegramIdentityService, AccountLinkService],
  exports: [TelegramIdentityService, AccountLinkService],
})
export class AccountsModule {}
