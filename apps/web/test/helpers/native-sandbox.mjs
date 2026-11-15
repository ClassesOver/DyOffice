import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
export async function sandboxFixture(kind = 'probe',limits = {}) {
  const { createSandboxProcess } = await import('../../worker/src/sandbox/process.ts')
  const metadata = JSON.parse(await readFile(process.env.DYOFFICE_TEST_NATIVE_MANIFEST ?? new URL('../../../../.dyoffice-native-build/manifest.json',import.meta.url),'utf8'))
  const image = kind === 'native' ? metadata.nativeImage : metadata.probeImage
  assert.match(image,/^sha256:[a-f0-9]{64}$/)
  return createSandboxProcess({ image,allowedCommands: kind === 'native' ? ['open','read_range','recalc_cells','save_archive','close'] : ['probe','network','pids','sleep','busy','allocate','flood','output','symlink'],limits })
}
