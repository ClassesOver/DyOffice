#!/usr/bin/env node
/**
 * One-shot local administrator bootstrap. Not a route or an app startup hook.
 * Requires a migration-role DB connection and never accepts passwords in argv.
 */
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { applyMigrations } from '../server/db/migrate.mjs'
import { createMigrationPool } from '../server/db/postgres.mjs'
import { createPasswordHasher } from '../server/auth/passwords.mjs'
import { bootstrapInitialAdmin } from '../server/auth/bootstrap-admin.mjs'

export function parseBootstrapArgs(args) {
  const parsed = { passwordStdin: false }
  const names = new Map([
    ['--deployment-id','deploymentId'], ['--username','username'],
    ['--display-name','displayName'],
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--password-stdin') {
      if (parsed.passwordStdin) throw new Error('Duplicate CLI argument')
      parsed.passwordStdin = true
      continue
    }
    const key = names.get(arg)
    if (!key || typeof args[i + 1] !== 'string' || args[i + 1].startsWith('--') ||
        Object.hasOwn(parsed, key)) throw new Error('Unsupported or duplicate CLI argument')
    parsed[key] = args[++i]
  }
  if (!parsed.deploymentId || !parsed.username) {
    throw new Error('Usage: bootstrap-admin --deployment-id UUID --username LOGIN [--display-name NAME] [--password-stdin]')
  }
  parsed.displayName ??= parsed.username
  return parsed
}

async function readPasswordFromStdin(input) {
  let result = ''
  for await (const chunk of input) {
    result += chunk.toString('utf8')
    if (Buffer.byteLength(result, 'utf8') > 1026) throw new Error('Password input too long')
  }
  result = result.replace(/\r?\n$/, '')
  if (/[\r\n]/.test(result)) throw new Error('Password input must contain one line')
  return result
}

async function readHiddenPassword(input, output, prompt) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Interactive TTY required; or explicitly use --password-stdin')
  }
  output.write(prompt)
  return new Promise((resolvePassword, rejectPassword) => {
    const wasRaw = input.isRaw === true
    const decoder = new StringDecoder('utf8')
    let password = ''
    let closed = false
    const finish = (error) => {
      if (closed) return
      closed = true
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      if (error) rejectPassword(error)
      else resolvePassword(password)
    }
    const onEnd = () => finish(new Error('Password input interrupted'))
    const onData = (bytes) => {
      for (const character of decoder.write(bytes)) {
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Password input interrupted'))
        if (character === '\u007f' || character === '\b') {
          password = Array.from(password).slice(0, -1).join('')
        } else if (Buffer.byteLength(password + character, 'utf8') <= 1024) {
          password += character
        } else return finish(new Error('Password input too long'))
      }
    }
    input.setRawMode(true)
    input.on('data', onData)
    input.once('end', onEnd)
    input.resume()
  })
}

export async function readBootstrapPassword({ passwordStdin }, input = process.stdin, output = process.stderr) {
  if (passwordStdin) {
    if (input.isTTY) throw new Error('--password-stdin requires a pipe, not a terminal')
    return readPasswordFromStdin(input)
  }
  const password = await readHiddenPassword(input, output, 'New administrator password: ')
  const confirmation = await readHiddenPassword(input, output, 'Confirm password: ')
  if (password !== confirmation) throw new Error('Passwords did not match')
  return password
}

export async function runBootstrap(args = process.argv.slice(2)) {
  const options = parseBootstrapArgs(args)
  const password = await readBootstrapPassword(options)
  const pool = createMigrationPool()
  try {
    await applyMigrations(pool)
    const result = await bootstrapInitialAdmin({
      pool, passwordHasher: createPasswordHasher({ maxConcurrent: 1 }),
      deploymentId: options.deploymentId, username: options.username,
      displayName: options.displayName, password,
    })
    process.stdout.write('Initial administrator account created: ' + result.username + '\n')
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBootstrap().catch(() => {
    // Never print authentication inputs, database exception details or hashes.
    process.stderr.write('Administrator bootstrap failed. Check account state and secure operation logs.\n')
    process.exitCode = 1
  })
}
