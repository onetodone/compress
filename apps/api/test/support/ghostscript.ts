import { spawnSync } from 'node:child_process'

/** Ghostscript executable used by tests. */
export const GHOSTSCRIPT_PATH = 'gs'

/**
 * Whether Ghostscript is installed. Tests that run it are skipped without it locally; CI installs it,
 * so they never skip there.
 */
export const ghostscriptAvailable = spawnSync(GHOSTSCRIPT_PATH, ['--version']).status === 0

if (!ghostscriptAvailable && process.env.CI) throw new Error('Ghostscript is required to run the tests in CI')

/** A valid one-page PDF with a line of text and no images, built byte by byte. */
export function textOnlyPdf(): Buffer {
  const content = 'BT /F1 12 Tf 20 20 Td (Hello) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
