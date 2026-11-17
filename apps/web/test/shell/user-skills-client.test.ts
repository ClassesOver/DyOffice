import {test, expect} from 'vitest'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'
import {createLocalShellClient} from '../../src/shell/local-client'

test('imports SKILL.md using existing metadata parser and never sends owner or filesystem paths', async () => {
  const requests: unknown[] = []
  const client = createUserSkillsClient(async (path, method, body) => {
    requests.push({path, method, body})
    return {name: 'report', description: 'Private report'} as never
  })
  const result = await client.importText('---\nname: report\ndescription: Private report\n---\n# Write a DOCX report')
  expect(requests).toEqual([{path: '/api/v1/skills/report', method: 'PUT', body: {description: 'Private report', body: '# Write a DOCX report'}}])
  expect(result.name).toBe('report')
  await expect(client.importText('---\nname: ../alice\ndescription: bad\n---\nbody')).rejects.toThrow()
  expect(requests).toHaveLength(1)
})

test('a Skills response completing after account invalidation is rejected before entering the menu', async () => {
  let resolve!: (r: Response) => void
  const local = createLocalShellClient(() => new Promise(r => {resolve = r}))
  const work = createUserSkillsClient(local.request).listSkills()
  local.invalidateSession()
  resolve(new Response(JSON.stringify([{name: 'alice-private', description: 'secret'}])))
  await expect(work).rejects.toMatchObject({code: 'stale_session'})
})

test('a reply from a previous account is discarded when a different tab changes its session', async () => {
  let proof = 'a'.repeat(43)
  const local = createLocalShellClient(async (path, init) => {
    if (String(path).endsWith('/session-proof')) return new Response(JSON.stringify({csrfToken: proof}))
    expect((init?.headers as Record<string,string>)['X-CSRF-Token']).toBe('a'.repeat(43))
    proof = 'b'.repeat(43)
    return new Response(JSON.stringify([{name: 'alice-private', description: 'secret'}]))
  })
  const bound = await local.bindSession()
  await expect(createUserSkillsClient(bound.request).listSkills()).rejects.toMatchObject({code: 'stale_session'})
})
