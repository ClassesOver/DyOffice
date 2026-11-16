import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
export async function sandboxFixture(kind = 'probe',limits = {}) {
  const { createHostProcess } = await import('../../worker/src/sandbox/host-process.ts')
  const metadata = JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST ?? new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
  return createHostProcess({ deploymentId: randomUUID(),binary: kind === 'native' ? metadata.nativeBinary : metadata.probeBinary,sha256: kind === 'native' ? metadata.nativeSha256 : metadata.probeSha256,allowedCommands: kind === 'native' ? ['open','read_range','recalc_cells','save_archive','close'] : ['probe','network','pids','sleep','busy','allocate','flood','output','symlink'],limits })
}
