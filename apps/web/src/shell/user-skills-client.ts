import {parseSkillFrontmatter} from '@genoffice/agent-core'
import type {FoundSkill} from '../../../shell/src/shared/found-skill'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {classifyOfficeSkill, OFFICE_SKILL_REQUIRED} from './office-skills'

type SkillMetadata = {name: string; description: string}
/** Session-scoped request rejects late replies after logout. No shared cache. */
export function createUserSkillsClient(request: SettingsRequest) {
  const path = (name: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error('Skill 名称只能包含字母、数字、下划线和连字符。')
    return '/api/v1/skills/' + encodeURIComponent(name)
  }
  const entry = (skill: SkillMetadata, body = ''): FoundSkill => ({...skill, path: path(skill.name), relevance: classifyOfficeSkill(skill.name, skill.description, body)})
  return {
    async listSkills() {
      const skills = await request<SkillMetadata[]>('/api/v1/skills')
      // The existing list endpoint omits bodies. Read only unclassified entries
      // to include skills whose Office scope is described solely in the body.
      const entries = await Promise.all(skills.map(async skill => {
        const metadata = entry(skill)
        if (metadata.relevance.relevant) return metadata
        const detail = await request<{body: string}>(path(skill.name))
        return entry(skill, detail.body)
      }))
      return entries.filter(skill => skill.relevance.relevant)
    },
    async skillText(name: string) {
      const skill = await request<SkillMetadata & {body: string}>(path(name))
      if (!classifyOfficeSkill(name, skill.description ?? '', skill.body).relevant) throw new Error(OFFICE_SKILL_REQUIRED)
      return skill.body
    },
    async importText(source: string, options: {overwrite?: boolean} = {}) {
      if (new TextEncoder().encode(source).byteLength > 262144) throw new Error('SKILL.md 超过 256 KiB 限制。')
      const skill = parseSkillFrontmatter(source)
      if (!skill || !skill.body.trim()) throw new Error('SKILL.md 需要 name、description 和正文。')
      if (!classifyOfficeSkill(skill.name, skill.description, skill.body).relevant) throw new Error(OFFICE_SKILL_REQUIRED)
      if (options.overwrite === false) {
        let existing:SkillMetadata[]
        try{existing=await request<SkillMetadata[]>('/api/v1/skills')}
        catch(failure){throw Object.assign(new Error(failure instanceof Error?failure.message:'无法读取技能列表。'),{mutationStarted:false})}
        if (existing.some(item => item.name === skill.name)) throw Object.assign(new Error('同名技能已存在，未覆盖。'), {status:409})
      }
      const saved = await request<SkillMetadata>(path(skill.name), 'PUT', {description: skill.description, body: skill.body,...(options.overwrite===false?{overwrite:false}:{})})
      return entry(saved, skill.body)
    },
    async removeSkill(name: string) { await request(path(name), 'DELETE') },
  }
}
