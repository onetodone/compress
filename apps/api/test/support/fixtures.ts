import { readFileSync } from 'node:fs'

/** Image and PDF files in `test/fixtures`. */
export type FixtureName =
  | 'photo.jpg'
  | 'graphic.png'
  | 'photo.webp'
  | 'photo.avif'
  | 'photo.heic'
  | 'rotated.heic'
  | 'document.pdf'
  | 'corrupt.jpg'

/** Reads a file from `test/fixtures`. */
export function fixture(name: FixtureName): Buffer {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url))
}
