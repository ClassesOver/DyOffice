import { createControlledTextController } from '../apps/docs/src/renderer/editor/controlled-text-controller'
import { getCsrfToken } from './csrf'
import { installControlledQa } from './shell'
const config = JSON.parse(document.getElementById('controlled-config')!.textContent!)
installControlledQa({
  main: document.querySelector('main')!,
  fileId: config.fileId,
  createController: createControlledTextController,
  getCsrfToken,
})
