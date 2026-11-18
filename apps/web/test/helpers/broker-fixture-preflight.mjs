import {accessSync,constants,statSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

/** Test infrastructure only; not runtime admission or isolation proof.
 * Both fixed Rust artifacts must refuse without the test harness environment.
 * Check actual execution, not just X_OK: missing loaders/invalid binaries also fail.
 */
export function requireRunnableBrokerFixture(path) {
 const fail=()=>{throw new Error(`BROKER_FIXTURE_PREREQUISITE: ${path}; build document-broker and admission-fixture with unsafe-test-harness before running this suite`)}
 try {
  if(!statSync(path).isFile())fail()
  accessSync(path,constants.X_OK)
  const result=spawnSync(path,[],{shell:false,env:{},input:'',encoding:'utf8',timeout:2000,killSignal:'SIGKILL',maxBuffer:4096})
  if(result.error||result.signal||result.status!==78)fail()
 } catch {fail()}
}
