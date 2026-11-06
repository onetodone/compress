import { Module } from '@nestjs/common'

import { CleanupConsumer } from './cleanup.consumer.js'
import { CleanupService } from './cleanup.service.js'

/** Removes stale jobs once an hour. */
@Module({ providers: [CleanupService, CleanupConsumer] })
export class CleanupModule {}
