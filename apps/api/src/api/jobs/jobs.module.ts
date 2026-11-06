import { Module } from '@nestjs/common'

import { JobsController } from './jobs.controller.js'
import { JobsService } from '../../common/jobs/jobs.service.js'

/** Job creation with presigned uploads, submission, listing, downloads and deletion. */
@Module({ controllers: [JobsController], providers: [JobsService] })
export class JobsModule {}
