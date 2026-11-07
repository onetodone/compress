import { Module } from '@nestjs/common'

import { AccountLinkService } from './account-link.service.js'
import { LibraryMergeService } from './library-merge.service.js'
import { TelegramIdentityService } from './telegram-identity.service.js'

/** Telegram identities, the links between Telegram accounts and website users, and merging their images. */
@Module({
  providers: [TelegramIdentityService, AccountLinkService, LibraryMergeService],
  exports: [TelegramIdentityService, AccountLinkService],
})
export class AccountsModule {}
