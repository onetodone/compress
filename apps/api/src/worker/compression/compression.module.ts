import { Logger, Module } from '@nestjs/common'

import type { GhostscriptConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { GhostscriptPdfCompressor, PdfCompressor, UnavailablePdfCompressor } from './compress-pdf.js'
import { CompressionConsumer } from './compression.consumer.js'
import { CompressionService } from './compression.service.js'

/**
 * Creates the Ghostscript {@link PdfCompressor} when `GHOSTSCRIPT_PATH` is set, otherwise one that
 * refuses every PDF.
 * @throws Error when the configured Ghostscript cannot be run, so the worker does not start
 */
export async function createPdfCompressor(config: GhostscriptConfig): Promise<PdfCompressor> {
  const logger = new Logger('Ghostscript')
  const path = config.GHOSTSCRIPT_PATH
  if (!path) {
    logger.log('GHOSTSCRIPT_PATH is not set: PDF compression is disabled')
    return new UnavailablePdfCompressor()
  }
  const compressor = new GhostscriptPdfCompressor(path)
  const version = await compressor.version().catch((error: unknown) => {
    throw new Error(`GHOSTSCRIPT_PATH: cannot run ${path}`, { cause: error })
  })
  logger.log({ version }, 'PDF compression uses Ghostscript')
  return compressor
}

/** Consumes the compression queue. */
@Module({
  providers: [
    CompressionService,
    CompressionConsumer,
    { provide: PdfCompressor, useFactory: createPdfCompressor, inject: [CONFIG] },
  ],
})
export class CompressionModule {}
