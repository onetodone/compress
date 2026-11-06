/**
 * Counts anonymous jobs per client network and UTC day. Injected by this class, so tests can
 * replace the Redis implementation.
 */
export abstract class NetworkQuota {
  /** Jobs counted for the network on the day. */
  abstract used(network: string, dayKey: string): Promise<number>

  /**
   * Counts one job for the network if it is still below the limit.
   * @returns whether the job was counted
   */
  abstract reserve(network: string, dayKey: string, limit: number): Promise<boolean>

  /** Gives back a job counted by {@link reserve} that was not submitted after all. */
  abstract release(network: string, dayKey: string): Promise<void>
}
