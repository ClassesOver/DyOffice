import { join } from 'node:path'
import { exportImageNames } from '../shared/export-image-names'

/**
 * File paths for a page-image export, in page order: <baseName>-01.<ext> …
 * The zero-padding width follows the total page count (3 digits for ≥100 pages)
 * so file browsers sort the pages naturally.
 */
export function buildExportImagePaths(
  dir: string,
  baseName: string,
  count: number,
  ext: 'png' | 'jpg',
): string[] {
  return exportImageNames(baseName, count, ext).map(name => join(dir, name))
}
