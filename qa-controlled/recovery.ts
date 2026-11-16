import {
  createHttpCommandRecoveryClient,
  installCommandRecoveryPage,
} from '../packages/browser-host/src/command-recovery-ui'
import { getCsrfToken } from './csrf'
const config = JSON.parse(document.getElementById('recovery-config')!.textContent!)
installCommandRecoveryPage(document.querySelector('main')!, {
  fileId: config.fileId,
  commandId: config.commandId,
  createClient: () => createHttpCommandRecoveryClient({ getCsrfToken }),
})
