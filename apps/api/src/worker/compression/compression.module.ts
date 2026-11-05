import { Module } from '@nestjs/common'

import { CompressionConsumer } from './compression.consumer.js'
import { CompressionService } from './compression.service.js'

/** Consumes the compression queue. */
@Module({ providers: [CompressionService, CompressionConsumer] })
export class CompressionModule {}
