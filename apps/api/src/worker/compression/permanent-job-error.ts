/**
 * A failure that repeating the task cannot fix, such as a corrupt or unsupported file. The message
 * is shown to the user.
 */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError'

  /**
   * @param message user-safe reason, stored on the job
   * @param detail what the tool reported, for the log only
   */
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}
