import { readFile } from 'node:fs/promises'
import { createSandboxProcess } from '../../worker/src/sandbox/process.ts'
try {
  const metadata = JSON.parse(await readFile(process.env.DYOFFICE_TEST_NATIVE_MANIFEST,'utf8'))
  const runner = createSandboxProcess({ image: metadata.probeImage,allowedCommands: ['park'],limits: { wallMs: 2500 } })
  await runner.run(Buffer.from('crash probe'),async session => {
    await session.request('park',{})
    process.stdout.write('native-parked\n')
    await new Promise(() => {})
  })
} catch { process.stderr.write('Controlled parked native fixture failed\n'); process.exitCode=85 }
