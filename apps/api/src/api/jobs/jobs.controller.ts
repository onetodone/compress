import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, Post, Query } from '@nestjs/common'
import {
  type CreateJobRequest,
  createJobRequestSchema,
  type CreateJobResponse,
  type DownloadJobQuery,
  downloadJobQuerySchema,
  type DownloadJobResponse,
  type ListJobsQuery,
  listJobsQuerySchema,
  type ListJobsResponse,
  type SubmitJobResponse,
} from '@onetodone/compress-shared'

import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js'
import type { AuthUser } from '../../common/auth/auth-user.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { JobsService } from '../../common/jobs/jobs.service.js'

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listJobsQuerySchema)) query: ListJobsQuery,
  ): Promise<ListJobsResponse> {
    return this.jobs.list(user, query)
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string | undefined,
    @Body(new ZodValidationPipe(createJobRequestSchema)) body: CreateJobRequest,
  ): Promise<CreateJobResponse> {
    return this.jobs.create(user, ip, body)
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string | undefined,
    @Param('id') id: string,
  ): Promise<SubmitJobResponse> {
    return this.jobs.submit(user, ip, id)
  }

  @Get(':id/download')
  download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(downloadJobQuerySchema)) query: DownloadJobQuery,
  ): Promise<DownloadJobResponse> {
    return this.jobs.download(user, id, query)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    return this.jobs.delete(user, id)
  }
}
