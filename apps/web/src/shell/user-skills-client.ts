import {classifySkill, parseSkillFrontmatter} from '@genoffice/agent-core'
import type {FoundSkill} from '../../../shell/src/shared/found-skill'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'

/** Session-scoped request rejects late replies after logout. No shared cache. */
export function createUserSkillsClient(request: SettingsRequest) {
  const path = (name: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error('Skill 名称只能包含字母、数字、下划线和连字符。')
    return '/api/v1/skills/' + encodeURIComponent(name)
  }
  const entry = (skill: {name: string; description: string}): FoundSkill => ({...skill, path: path(skill.name), relevance: classifySkill(skill.name, skill.description)})
  return {
    async listSkills() { return (await request<{name: string; description: string}[]>('/api/v1/skills')).map(entry) },
    async skillText(name: string) { return (await request<{body: string}>(path(name))).body },
    async importText(source: string) {
      if (new TextEncoder().encode(source).byteLength > 262144) throw new Error('SKILL.md 超过 256 KiB 限制。')
      const skill = parseSkillFrontmatter(source)
      if (!skill || !skill.body.trim()) throw new Error('SKILL.md 需要 name、description 和正文。')
      return entry(await request(path(skill.name), 'PUT', {description: skill.description, body: skill.body}))
    },
    async removeSkill(name: string) { await request(path(name), 'DELETE') },
  }
}
