import { Logger, Module } from '@nestjs/common'

import type { CompressionToolsConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { HeicEncoder, LibheifHeicEncoder, UnavailableHeicEncoder } from './compress-heic.js'
import { GhostscriptPdfCompressor, PdfCompressor, UnavailablePdfCompressor } from './compress-pdf.js'
import { CompressionConsumer } from './compression.consumer.js'
import { CompressionService } from './compression.service.js'

/**
 * Creates the Ghostscript {@link PdfCompressor} when `GHOSTSCRIPT_PATH` is set, otherwise one that
 * refuses every PDF.
 * @throws Error when the configured Ghostscript cannot be run, so the worker does not start
 */
export async function createPdfCompressor(
  config: Pick<CompressionToolsConfig, 'GHOSTSCRIPT_PATH'>,
): Promise<PdfCompressor> {
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

/**
 * Creates the libheif {@link HeicEncoder} when `HEIF_TOOLS_DIR` is set, otherwise one that refuses
 * every HEIC image.
 * @throws Error when the configured tools cannot be run or lack an HEVC codec, so the worker does not start
 */
export async function createHeicEncoder(config: Pick<CompressionToolsConfig, 'HEIF_TOOLS_DIR'>): Promise<HeicEncoder> {
  const logger = new Logger('Libheif')
  const dir = config.HEIF_TOOLS_DIR
  if (!dir) {
    logger.log('HEIF_TOOLS_DIR is not set: HEIC compression is disabled')
    return new UnavailableHeicEncoder()
  }
  const encoder = new LibheifHeicEncoder(dir)
  const version = await encoder.check().catch((error: unknown) => {
    throw new Error(`HEIF_TOOLS_DIR: cannot use heif-dec and heif-enc in ${dir}`, { cause: error })
  })
  logger.log({ version }, 'HEIC compression uses libheif')
  return encoder
}

/** Consumes the compression queue. */
@Module({
  providers: [
    CompressionService,
    CompressionConsumer,
    { provide: PdfCompressor, useFactory: createPdfCompressor, inject: [CONFIG] },
    { provide: HeicEncoder, useFactory: createHeicEncoder, inject: [CONFIG] },
  ],
})
export class CompressionModule {}
