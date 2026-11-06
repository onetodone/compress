import { Injectable, Logger } from '@nestjs/common'
import { downloadFileName, imageTypeSchema, type JobSummary, toJobSummary } from '@onetodone/compress-shared'
import { FieldValue, Firestore } from 'firebase-admin/firestore'

import { awaitsChatAnswer, JOBS, readChatTarget } from '../../common/jobs/job-records.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { ObjectStorage } from '../../common/r2/object-storage.js'
import { failureText, resultCaption } from '../bot-messages.js'
import { ChatError, ChatGateway } from '../chat-gateway.js'

/**
 * What a notification task did: answered the chat (`sent`), found nothing to answer (`skipped`), or
 * gave up because the chat can no longer be reached (`undeliverable`).
 */
export type NotificationOutcome = 'sent' | 'skipped' | 'undeliverable'

/** gRPC status of an update of a document that does not exist. */
const NOT_FOUND = 5

/**
 * Answers the chat message a finished job came from, with the result file or the error. Safe to run
 * more than once for a job: `notifiedAt` records the answer, so only a crash between sending and
 * recording it can send a second one.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly storage: ObjectStorage,
    private readonly chat: ChatGateway,
    private readonly timer: CallTimer,
  ) {}

  /** @throws Error on a transient failure, so the task is retried */
  async deliver(jobId: string): Promise<NotificationOutcome> {
    const ref = this.firestore.collection(JOBS).doc(jobId)
    const snapshot = await this.timer.measure('firestore', 'jobs.get', () => ref.get())
    const data = snapshot.data()
    const target = readChatTarget(data)
    const job = data && toJobSummary(jobId, data)
    if (!target || !job || !awaitsChatAnswer(data)) return 'skipped'

    try {
      if (job.status === 'done') {
        const outputKey = data.outputKey as string
        const result = await this.storage.get(outputKey)
        if (!result) {
          // Only a job deleted meanwhile has no result; its document is gone by now.
          this.logger.warn({ jobId }, 'Finished job without a result file')
          return 'skipped'
        }
        await this.chat.sendDocument(
          target.chatId,
          { data: result, fileName: resultFileName(job) },
          { replyTo: target.messageId, caption: resultCaption(job) },
        )
      } else {
        await this.chat.sendMessage(target.chatId, failureText(job, data.quotaRefunded === true), {
          replyTo: target.messageId,
        })
      }
    } catch (error) {
      if (!(error instanceof ChatError && error.kind === 'chat_unavailable')) throw error
      this.logger.warn({ jobId, err: error }, 'The chat of a finished job cannot be reached')
      await this.markNotified(jobId)
      return 'undeliverable'
    }

    await this.markNotified(jobId)
    try {
      await this.chat.setReaction(target.chatId, target.messageId, null)
    } catch (error) {
      this.logger.debug({ jobId, err: error }, 'Could not remove a reaction')
    }
    return 'sent'
  }

  private async markNotified(jobId: string): Promise<void> {
    const ref = this.firestore.collection(JOBS).doc(jobId)
    try {
      await this.timer.measure('firestore', 'jobs.notified', () =>
        ref.update({ notifiedAt: FieldValue.serverTimestamp() }),
      )
    } catch (error) {
      // The owner deleted the job right after it was answered.
      if ((error as { code?: unknown }).code !== NOT_FOUND) throw error
    }
  }
}

/** Name of the result file: the original name with the extension of the result type. */
function resultFileName(job: JobSummary): string {
  const type = imageTypeSchema.safeParse(job.outputType ?? job.inputType)
  return type.success ? downloadFileName(job.originalName, type.data) : job.originalName
}
