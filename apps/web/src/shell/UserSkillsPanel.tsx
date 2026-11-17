import {useEffect, useRef} from 'react'
import {FoundSkills} from '../../../shell/src/renderer/src/FoundSkills'
import {useI18n} from '../../../shell/src/renderer/src/locale'
import type {createUserSkillsClient} from './user-skills-client'
import type {FoundSkill} from '../../../shell/src/shared/found-skill'

export function UserSkillsPanel({client}: {client: ReturnType<typeof createUserSkillsClient>}) {
  const {t} = useI18n(), input = useRef<HTMLInputElement>(null)
  const pending = useRef<{resolve(value: FoundSkill | null): void; reject(error: unknown): void} | null>(null)
  useEffect(() => {
    const cancel = () => {pending.current?.resolve(null); pending.current = null}
    const element = input.current
    element?.addEventListener('cancel', cancel)
    return () => {element?.removeEventListener('cancel', cancel); cancel()}
  }, [])
  return <>
    <p className="set-field-desc">Skills 保存到当前账号。只有登录此账号才能查看、删除或在助手中使用。</p>
    <input ref={input} type="file" accept=".md" hidden onChange={event => {
      const file = event.target.files?.[0], work = pending.current
      pending.current = null; event.target.value = ''
      if (!work) return
      if (!file) {work.resolve(null); return}
      if (file.size > 262144) {work.reject(new Error('SKILL.md 超过 256 KiB 限制。')); return}
      void file.text().then(client.importText).then(work.resolve, work.reject)
    }}/>
    <FoundSkills t={t} markdownOnly adapter={{listSkills: client.listSkills, skillBody: path => client.skillText(path.slice('/api/v1/skills/'.length)), removeSkill: client.removeSkill, importSkillZip: () => new Promise((resolve, reject) => {
      pending.current = {resolve, reject}; input.current?.click()
    })}}/>
  </>
}
