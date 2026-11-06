import { readFileSync } from 'node:fs'

/** Image files in `test/fixtures`. */
export type FixtureName = 'photo.jpg' | 'graphic.png' | 'photo.webp' | 'photo.avif' | 'corrupt.jpg'

/** Reads an image from `test/fixtures`. */
export function fixture(name: FixtureName): Buffer {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url))
}
