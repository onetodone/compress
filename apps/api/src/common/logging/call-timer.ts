import type { LoggerService } from '@nestjs/common'

/** External services whose calls are timed by {@link CallTimer}. */
export type ExternalService = 'firestore' | 'auth' | 'r2' | 'cloudinary' | 'redis' | 'telegram'

/** Measures calls to external services and logs a warning for every call slower than the threshold. */
export class CallTimer {
  /**
   * @param thresholdMs calls that take longer are logged (`SLOW_CALL_THRESHOLD_MS`)
   * @param logger receives one warning per slow call
   */
  constructor(
    private readonly thresholdMs: number,
    private readonly logger: Pick<LoggerService, 'warn'>,
  ) {}

  /**
   * Runs `call` and returns its result. The duration is checked whether the call succeeds or fails.
   * @param service the external service being called
   * @param operation short name of the operation, e.g. `users.get`
   * @param call the call to measure
   */
  async measure<T>(service: ExternalService, operation: string, call: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await call()
    } finally {
      const durationMs = Math.round(performance.now() - started)
      if (durationMs > this.thresholdMs) {
        this.logger.warn({ service, operation, durationMs }, `Slow ${service} call: ${operation} took ${durationMs} ms`)
      }
    }
  }
}
