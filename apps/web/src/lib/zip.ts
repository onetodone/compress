import { type Zippable, zipSync } from 'fflate'

/** A file to put into an archive. */
export interface ZipEntry {
  name: string
  data: Uint8Array
}

function safeName(name: string): string {
  // Slashes would create folders, and some unzip tools refuse names that climb out of the target.
  const cleaned = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim()
  return cleaned === '' || /^\.+$/.test(cleaned) ? 'image' : cleaned
}

/**
 * Makes file names usable and unique inside one archive, keeping the first name of each as it is
 * and numbering repeats like a file manager does: `photo.jpg`, `photo (2).jpg`. Names are compared
 * without case, because Windows and macOS would overwrite one file with the other when extracting.
 * @param names file names in archive order
 * @returns the names to use, in the same order
 */
export function uniqueFileNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const cleaned = safeName(name)
    const dot = cleaned.lastIndexOf('.')
    const [stem, extension] = dot > 0 ? [cleaned.slice(0, dot), cleaned.slice(dot)] : [cleaned, '']
    let candidate = cleaned
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${extension}`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * Builds a ZIP archive. Entries are stored without compression: the images are compressed already,
 * so deflating them again costs time and saves next to nothing.
 * @param entries files with names that are unique in the archive (see {@link uniqueFileNames})
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {}
  for (const { name, data } of entries) files[name] = [data, { level: 0 }]
  return zipSync(files) as Uint8Array<ArrayBuffer>
}
