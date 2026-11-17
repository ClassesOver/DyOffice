import {expect,test} from 'vitest'
import {parseSkillFrontmatter} from '@genoffice/agent-core'
import {WEB_OFFICE_SKILL_CATALOG} from '../../src/shell/office-skill-catalog'
import {classifyOfficeSkill} from '../../src/shell/office-skills'

test('migrates every eligible DyOffice recommended task with its original identity and body',()=>{
 const originals=import.meta.glob('../../../../skills/recommended/*/SKILL.md',{query:'?raw',import:'default',eager:true}) as Record<string,string>
 const eligible=Object.values(originals).map(source=>({source,parsed:parseSkillFrontmatter(source)!})).filter(({parsed})=>classifyOfficeSkill(parsed.name,parsed.description,parsed.body).relevant)
 expect(WEB_OFFICE_SKILL_CATALOG).toHaveLength(37)
 expect(WEB_OFFICE_SKILL_CATALOG.map(item=>item.key).sort()).toEqual(eligible.map(({parsed})=>parsed.name).sort())
 for(const {source,parsed} of eligible){const entry=WEB_OFFICE_SKILL_CATALOG.find(item=>item.key===parsed.name)!
  expect(entry.source.startsWith(source.trimEnd())).toBe(true)
  expect(parseSkillFrontmatter(entry.source)?.name).toBe(parsed.name)
  expect(entry.source).toContain('Web 工具适配')
  expect(entry.formats.length).toBeGreaterThan(0)
 }
})
test('excludes Markdown, HTML and desktop CLI task resources from the installation catalog',()=>{
 expect(classifyOfficeSkill('word-help','Word document task','Read this SKILL.md before editing Word.').relevant).toBe(true)
 for(const format of ['.md','MD','Markdown','.html','HTML'])expect(classifyOfficeSkill('word-export',`Word report with ${format} output`).relevant).toBe(false)
 for(const name of ['brand-copy','email-drafter','interview-coach','seo-content','social-media','genoffice'])expect(WEB_OFFICE_SKILL_CATALOG.some(item=>item.key===name)).toBe(false)
 expect(WEB_OFFICE_SKILL_CATALOG.some(item=>item.key.startsWith('web-'))).toBe(false)
})
