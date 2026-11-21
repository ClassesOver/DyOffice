import {fileURLToPath} from 'node:url'

/** Output directory of build-worker.mjs, read at runtime by worker-launch.mjs (kept free of esbuild). */
export const PDF_WORKER_BUNDLE_DIR=fileURLToPath(new URL('../../../dist-pdf-worker/',import.meta.url))
