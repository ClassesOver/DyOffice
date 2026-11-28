// Chart paths are decoded ZIP entry names. Preserve producer-chosen filenames
// and subdirectories while requiring a normalized path under xl/charts.
export const WORKBOOK_CHART_PATH = /^xl\/charts\/(?:(?!\.{1,2}\/)[^/\\\x00-\x1f\x7f]+\/)*[^/\\\x00-\x1f\x7f]+\.xml$/u
