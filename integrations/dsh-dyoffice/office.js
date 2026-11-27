import {createHash,randomUUID} from 'node:crypto'
import {readFile, rename, unlink, writeFile} from 'node:fs/promises'

export const route = '/dyoffice-preview'
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const activeStates = new Set(['queued', 'running', 'waiting_peer', 'cancel_requested'])

export function officeOrigin(value) {
  let address
  try { address = new URL(value) } catch { throw Object.assign(Error('Invalid DyOffice URL.'), {status: 400}) }
  if (address.username || address.password || address.pathname !== '/' || address.search || address.hash ||
      (address.protocol !== 'https:' && !(address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)))) {
    throw Object.assign(Error('Use a DyOffice HTTPS origin or a loopback HTTP origin.'), {status: 400})
  }
  return address.origin
}

export function officeSettings(config = {}, originOverride) {
  const originValue = originOverride ?? process.env.DSH_DYOFFICE_ORIGIN ?? config.origin
  const memberFile = process.env.DSH_DYOFFICE_MEMBER_FILE ?? config.memberFile
  if (!memberFile) throw Object.assign(Error('DyOffice token storage is not configured.'), {status: 503})
  return {origin: originValue ? officeOrigin(originValue) : null, memberFile}
}

export async function storeOfficeToken(token, originValue, config, signal) {
  const pair = /^(https?:\/\/[^/?#]+)\/#dsh=([A-Za-z0-9_-]{1,2048})$/u.exec(token)
  if (pair) {
    originValue = pair[1]
    token = pair[2]
  }
  const {origin, memberFile} = officeSettings(config, originValue || undefined)
  if (!origin) throw Object.assign(Error('Enter the DyOffice URL.'), {status: 400})
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw Object.assign(Error('Invalid authorization token.'), {status: 400})
  const response = await fetch(origin + '/api/v1/assistant-channels/member', {
    headers: {authorization: 'Bearer ' + token},
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  })
  if (!response.ok) throw Object.assign(Error('DyOffice returned HTTP ' + response.status + '.'), {status: response.status})
  const self = await response.json()
  if (!uuid.test(self?.conversationId) || !uuid.test(self?.member?.membershipId)) throw Error('Invalid DyOffice identity response.')
  const temporary = memberFile + '.' + randomUUID()
  try {
    await writeFile(temporary, JSON.stringify({token, origin}) + '\n', {mode: 0o600, flag: 'wx'})
    await rename(temporary, memberFile)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function connectOffice(signal, config) {
  const configured = officeSettings(config)
  let credential
  try {
    credential = JSON.parse(await readFile(configured.memberFile, {encoding: 'utf8', signal}))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(Error('DyOffice authorization is required.'), {
        status: 428, origin: configured.origin,
        authorizationUrl: configured.origin ? configured.origin + '/?panel=channels' : undefined,
      })
    }
    throw Object.assign(Error('Cannot read the DyOffice membership file.'), {status: 503})
  }
  const token = credential?.token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(token)) {
    throw Object.assign(Error('Invalid DyOffice membership file.'), {status: 503})
  }
  let origin
  try { origin = officeSettings(config, credential.origin).origin } catch {
    throw Object.assign(Error('Invalid DyOffice membership file.'), {status: 503})
  }
  if (!origin) {
    throw Object.assign(Error('DyOffice URL is required.'), {status: 428, origin: null})
  }
  const request = async (path, body, headers) => {
    const response = await fetch(origin + '/api/v1/assistant-channels' + path, {
      method: body ? 'POST' : 'GET',
      headers: {...headers, authorization: 'Bearer ' + token, ...(body && {'content-type': 'application/json'})},
      body: body && JSON.stringify(body), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000),
    })
    if (!response.ok) throw Object.assign(Error('DyOffice returned HTTP ' + response.status + '.'), {status: response.status})
    return response.json()
  }
  const identity = await request('/member').catch(error => {
    if ([401,403,404].includes(error.status)) throw Object.assign(Error('DyOffice authorization is required.'), {
      status: 428, origin, authorizationUrl: origin + '/?panel=channels',
    })
    throw error
  })
  if (!uuid.test(identity?.conversationId) || !uuid.test(identity?.member?.membershipId)) {
    throw Object.assign(Error('Invalid DyOffice identity response.'), {status: 503})
  }
  const base = '/members/' + identity.member.membershipId
  return {
    origin,
    connectionKey: createHash('sha256').update(origin + '\n' + token).digest('hex'),
    conversationId: identity.conversationId,
    fileId: identity.fileId,
    fileName: identity.fileName,
    fileFormat: identity.fileFormat,
    paused: identity.paused === true,
    canCreate: identity.canCreate,
    canEdit: identity.canEdit === true,
    dshEditorOrigin: identity.dshEditorOrigin,
    dshEditorOrigins: identity.dshEditorOrigins,
    createDocument: body => request('/member/documents', body),
    createdPreview: (fileId, proof, after, head) => request('/member/documents/' + fileId + '/preview' + (head ? '?head=1' : after ? '?after=' + after : ''),
      undefined, {'X-DyOffice-Document-Preview': proof}),
    editTicket: (fileId, proof) => request('/member/documents/' + fileId + '/edit-ticket', {},
      proof && {'X-DyOffice-Document-Preview': proof}),
    draftSync: (fileId, proof, origin, write) => request('/member/documents/' + fileId + '/draft-sync', {origin, ...(write && {write: true})},
      {'X-DyOffice-Document-Preview': proof}),
    request: (path, body) => request(base + path, body),
  }
}
