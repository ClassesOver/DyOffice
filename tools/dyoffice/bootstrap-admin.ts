import { emitKeypressEvents } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { connectIdentityStore } from '../../apps/web/server/src/db/identity.ts'
import { createPasswordService } from '../../apps/web/server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../apps/web/server/src/modules/auth/service.ts'

async function prompt(label: string, hidden = false): Promise<string> {
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        process.stdin.off('keypress', onKey)
        process.stdout.write('\n')
        if (error) reject(error)
        else resolve(value)
      }
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(new Error('Cancelled'))
        if (key.name === 'return' || key.name === 'enter') return finish()
        if (key.name === 'backspace') {
          if (value.length) {
            value = [...value].slice(0, -1).join('')
            if (!hidden) process.stdout.write('\b \b')
          }
        } else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) {
          if (Buffer.byteLength(value + text, 'utf8') > 1024) return finish(new Error('Input too long'))
          value += text
          if (!hidden) process.stdout.write(text)
        }
      }
      process.stdin.on('keypress', onKey)
      process.stdout.write(label)
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive terminal required')
  if (process.argv.length !== 2 || process.env.DYOFFICE_ADMIN_PASSWORD || process.env.DYOFFICE_USER_TOKEN || process.env.DYOFFICE_ADMIN_TOKEN) throw new Error('arguments, password environment variables and development tokens are not accepted')
  const url = process.env.DYOFFICE_DATABASE_URL
  const deploymentId = process.env.DYOFFICE_DEPLOYMENT_ID
  if (!url || !deploymentId) throw new Error('DYOFFICE_DATABASE_URL and DYOFFICE_DEPLOYMENT_ID are required')
  const blockedPasswords = process.env.DYOFFICE_PASSWORD_BLOCKLIST_FILE
    ? (await readFile(process.env.DYOFFICE_PASSWORD_BLOCKLIST_FILE, 'utf8')).split(/\r?\n/).filter(Boolean) : []
  const username = await prompt('Administrator username: ')
  const password = await prompt('Password (hidden, at least 15 characters): ', true)
  const confirmation = await prompt('Confirm password (hidden): ', true)
  if (password !== confirmation) throw new Error('password confirmation mismatch')
  const passwords = await createPasswordService({ blockedPasswords })
  const { db, close } = connectIdentityStore(url)
  try {
    const service = createAccountService({ db, passwords, deploymentId })
    await db.migrate()
    await service.bootstrapAdmin({ username, password })
    process.stdout.write('Administrator created. Bootstrap is now closed for this deployment.\n')
  } finally { await close() }
}
main().catch(error => {
  const publicMessages = new Set(['interactive terminal required', 'arguments, password environment variables and development tokens are not accepted', 'DYOFFICE_DATABASE_URL and DYOFFICE_DEPLOYMENT_ID are required', 'password confirmation mismatch', 'Cancelled', 'Input too long'])
  const message = publicMessages.has(error.message) ? error.message
    : ['INVALID_USERNAME', 'INVALID_PASSWORD', 'BOOTSTRAP_CLOSED', 'AUTH_BUSY'].includes(error.code) ? error.code : 'initialization failed'
  console.error(`bootstrap-admin: ${message}`)
  process.exitCode = 1
})
