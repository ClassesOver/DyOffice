import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import docs from '../docs/vitest.config.ts'
export default defineConfig({
  ...docs,
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    ...docs.test,
    environment: 'node',
    setupFiles: [
      ...docs.test.setupFiles,
      fileURLToPath(new URL('./test/native-docs/native-command-dom.setup.mjs', import.meta.url)),
    ],
    include: ['apps/web/test/native-docs/command-persistence.integration.ts'],
    testTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
