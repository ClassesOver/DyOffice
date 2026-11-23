import {useEffect, useRef, useState} from 'react'
import {parseSkillFrontmatter} from '@genoffice/agent-core'
import {NativeSettingsDialog} from './NativeSettingsDialog'
import {NativeSettingsPager as SettingsListPager} from './NativeSettingsPager'
import './personal-skills-native.css'
import {WEB_OFFICE_SKILL_CATALOG} from './office-skill-catalog'
import {classifyOfficeSkill, OFFICE_SKILL_REQUIRED} from './office-skills'
import type {createUserSkillsClient} from './user-skills-client'
import type {FoundSkill} from '../../../shell/src/shared/found-skill'

export function UserSkillsPanel({client,onCloseGuardChange}: {client: ReturnType<typeof createUserSkillsClient>;onCloseGuardChange?:(guard:(()=>boolean)|null)=>void}) {
  const [skills, setSkills] = useState<FoundSkill[]>([])
  const [skillPage,setSkillPage]=useState(0)
  const currentSkillPage=Math.min(skillPage,Math.max(0,Math.ceil(skills.length/6)-1))
  const [listed, setListed] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState(''), [catalogFormat, setCatalogFormat] = useState('all'), [catalogPage, setCatalogPage] = useState(1)
  const catalog = WEB_OFFICE_SKILL_CATALOG.filter(skill => (catalogFormat === 'all' || skill.formats.includes(catalogFormat)) && `${skill.key} ${skill.name} ${skill.description}`.toLowerCase().includes(catalogSearch.trim().toLowerCase()))
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [view, setView] = useState<{name: string; body: string} | null>(null)
  const [removing, setRemoving] = useState<FoundSkill | null>(null)
  const [replacing, setReplacing] = useState<{name:string;source:string}|null>(null)
  const input = useRef<HTMLInputElement>(null), pending = useRef(false), generation = useRef(0)
  useEffect(()=>{const prevent=(event:BeforeUnloadEvent)=>{if(pending.current||uncertain||replacing){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[uncertain,replacing])
  function canClose() {
    if (pending.current) { setError('Skills 操作处理中，请完成后再关闭。'); return false }
    if (uncertain) { setError('Skills 操作结果未确认，请刷新列表核对后再关闭。'); return false }
    if (replacing) { setError('有待确认的 Skill 替换，请确认或取消替换后再关闭。'); return false }
    return true
  }
  useEffect(() => {
    onCloseGuardChange?.(busy || uncertain || replacing ? canClose : null)
    return () => onCloseGuardChange?.(null)
  }, [onCloseGuardChange, busy, uncertain, replacing])
  async function refresh() {
    if (pending.current) return
    const current = generation.current
    pending.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const items = await client.listSkills()
      if (current === generation.current) { setSkills(items); setSkillPage(0); setListed(true); setUncertain(false) }
    } catch { if (current === generation.current) setError('无法读取当前账号的 Skills，请刷新列表重试。') }
    finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  useEffect(() => {
    generation.current++; pending.current = false
    setSkills([]); setSkillPage(0); setListed(false); setView(null); setRemoving(null); setReplacing(null); setUncertain(false); setError(''); setMessage('')
    void refresh()
    return () => { generation.current++; pending.current = false }
  }, [client])
  async function read(skill: FoundSkill) {
    if (pending.current) return
    const current = generation.current
    pending.current = true; setBusy(true); setError(''); setView({name: skill.name, body: ''})
    try {
      const body = await client.skillText(skill.name)
      if (current === generation.current) setView(previous => previous?.name === skill.name ? {name: skill.name, body} : previous)
    } catch { if (current === generation.current) setError('Skill 内容读取失败，请关闭后重新查看。') }
    finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  async function mutate(action: () => Promise<unknown>, success: string, onConfirmed: () => void = () => {}, onConflict?:()=>void) {
    if (pending.current || uncertain) return
    const current = generation.current
    pending.current = true; setBusy(true); setError(''); setMessage(''); setRemoving(null)
    try {
      await action()
      if (current !== generation.current) return
      onConfirmed(); setMessage(success)
      try {
        const items = await client.listSkills()
        if (current === generation.current) setSkills(items)
      } catch { if (current === generation.current) setError('操作已成功，但列表刷新失败。请刷新列表，不要重复提交。') }
    } catch (failure) {
      if (current !== generation.current) return
      const status = (failure as {status?: number}).status
      const notSubmitted=(failure as {mutationStarted?:boolean}).mutationStarted===false
      const unknown = !notSubmitted&&(status === undefined || status >= 500 || status === 408)
      setUncertain(unknown)
      if(status===409)onConflict?.()
      setError(notSubmitted?'无法检查同名技能，尚未提交任何写入。请刷新列表或重新导入后重试。':unknown ? '操作结果未确认，请刷新列表核对后再操作；不要重复提交。' : status === 409 ? '同名技能已存在，未覆盖。请刷新当前账号列表核对。' : '操作被拒绝，请核对当前账号权限及 Skill 文件后重试。')
    } finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  async function install(skill: (typeof WEB_OFFICE_SKILL_CATALOG)[number]) {
    if (!listed || pending.current || uncertain || replacing || skills.some(item => item.name === skill.key)) return
    let saved: FoundSkill
    await mutate(async () => { saved = await client.importText(skill.source, {overwrite:false}) }, 'Skill 已添加到当前账号。', () => setSkills(items => [...items.filter(item => item.name !== saved.name), saved]))
  }
  async function importFile(file: File) {
    if (pending.current || uncertain || replacing) return
    if (!file.name.toLowerCase().endsWith('.md')) { setError('请选择 Markdown 格式的 SKILL.md 文件。'); return }
    if (file.size > 262144) { setError('SKILL.md 超过 256 KiB 限制。'); return }
    // Read and validate before starting a write, so local failures remain safe to retry.
    const current = generation.current
    pending.current = true; setBusy(true); setError(''); setMessage('')
    let source: string
    try { source = await file.text() }
    catch { if (current === generation.current) { setError('文件读取失败，请重新选择 SKILL.md。'); pending.current = false; setBusy(false) } return }
    if (current !== generation.current) return
    const parsed = parseSkillFrontmatter(source)
    if (new TextEncoder().encode(source).byteLength > 262144 || !parsed || !parsed.body.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(parsed.name)) {
      pending.current = false; setBusy(false); setError('SKILL.md 需要有效的 name、description 和正文，文件不得超过 256 KiB。'); return
    }
    if (!classifyOfficeSkill(parsed.name, parsed.description, parsed.body).relevant) {
      pending.current = false; setBusy(false); setError(OFFICE_SKILL_REQUIRED); return
    }
    pending.current = false
    await mutate(() => client.importText(source,{overwrite:false}), 'Skill 已导入当前账号。',undefined,()=>setReplacing({name:parsed.name,source}))
  }
  return <section className="personal-skills-native" aria-label="个人技能管理">
    <div className="personal-skills-toolbar"><p>将常用办公方法保存为个人技能，供助手使用。</p><div className="skill-actions"><button type="button" className="native-settings-button" disabled={busy} onClick={() => void refresh()}>刷新列表</button><button type="button" className="native-settings-button is-primary" disabled={busy || uncertain || !!replacing} onClick={() => input.current?.click()}>导入 SKILL.md</button></div></div>
    <p className="skill-hint">技能说明用于指导已有工具，不会安装程序或开通额外能力。</p>
    {error && <p className="native-settings-notice is-error" role="alert">{error}</p>}
    {message && <p className="native-settings-notice is-success" role="status">{message}</p>}
    <section className="skill-section" aria-labelledby="skill-catalog-title">
    <h3 id="skill-catalog-title">可安装的办公技能</h3><p className="skill-hint">选择所需技能安装到当前账号；已有同名技能不会被覆盖。</p>
    <div className="personal-skills-filters"><input className="native-settings-input" type="search" aria-label="搜索可安装技能" placeholder="搜索技能名称或说明" value={catalogSearch} onChange={event => {setCatalogSearch(event.target.value); setCatalogPage(1)}}/><select className="native-settings-input" aria-label="筛选技能格式" value={catalogFormat} onChange={event => {setCatalogFormat(event.target.value); setCatalogPage(1)}}><option value="all">全部格式</option>{['docx','xlsx','pptx','pdf'].map(value=><option key={value} value={value}>{value.toUpperCase()}</option>)}</select></div>
    <div className="skill-table-wrap"><table className="personal-skills-catalog"><thead><tr><th scope="col">技能</th><th scope="col">操作</th></tr></thead><tbody>{catalog.slice((catalogPage-1)*6,catalogPage*6).map(skill=><tr key={skill.key} data-row-key={skill.key}><td><strong>{skill.name}</strong><p>{skill.description}</p><div className="skill-formats">{skill.formats.map(format=><span key={format}>{format.toUpperCase()}</span>)}</div></td><td><div className="skill-actions"><button type="button" className="native-settings-button" onClick={()=>setView({name:skill.name,body:parseSkillFrontmatter(skill.source)?.body??skill.source})}>查看正文</button><button type="button" className="native-settings-button" disabled={!listed||busy||uncertain||skills.some(item=>item.name===skill.key)} onClick={()=>void install(skill)}>{skills.some(item=>item.name===skill.key)?'已添加':'安装'}</button></div></td></tr>)}{!catalog.length&&<tr><td colSpan={2} className="skill-empty">没有匹配的办公技能</td></tr>}</tbody></table></div>
    <SettingsListPager page={catalogPage-1} pageSize={6} total={catalog.length} onPageChange={page=>setCatalogPage(page+1)} label="办公技能目录"/>
    </section>
    <section className="skill-section" aria-labelledby="skill-owned-title"><h3 id="skill-owned-title">当前账号的办公技能</h3><p className="skill-hint">支持不超过 256 KiB、包含 name、description 和正文的 SKILL.md。其他类别的旧记录保留，但不在此处或助手技能列表中展示。</p>
    <input ref={input} type="file" accept=".md,text/markdown" hidden aria-label="导入 Skill 文件" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void importFile(file)}}/>
    <div className="skill-table-wrap"><table className="personal-skills-owned" aria-busy={busy}><thead><tr><th scope="col">技能</th><th scope="col">操作</th></tr></thead><tbody>{skills.slice(currentSkillPage*6,(currentSkillPage+1)*6).map(skill=><tr key={skill.name} data-row-key={skill.name}><td><strong>{WEB_OFFICE_SKILL_CATALOG.find(item=>item.key===skill.name)?.name??skill.name}</strong><small>{skill.name}</small><p>{skill.description}</p></td><td><div className="skill-actions"><button type="button" className="native-settings-button" disabled={busy} onClick={()=>void read(skill)}>查看</button><button type="button" className="native-settings-button is-danger" disabled={busy||uncertain} onClick={()=>setRemoving(skill)}>删除</button></div></td></tr>)}{!skills.length&&<tr><td colSpan={2} className="skill-empty">{busy?'正在读取个人技能…':'尚未导入办公技能'}</td></tr>}</tbody></table></div>
    <SettingsListPager page={currentSkillPage} pageSize={6} total={skills.length} onPageChange={setSkillPage} label="个人技能" disabled={busy||uncertain||!!replacing||!!removing}/>
    </section>
    {view&&<NativeSettingsDialog compact title={`Skill：${view.name}`} onClose={()=>setView(null)} footer={<button type="button" className="native-settings-button" onClick={()=>setView(null)}>关闭</button>}>
      <textarea className="native-settings-input skill-body-preview" aria-label="Skill 内容" value={view.body} readOnly rows={16}/>
      {error&&<p role="alert" className="native-settings-notice is-error">{error}</p>}
    </NativeSettingsDialog>}
    {replacing&&<NativeSettingsDialog compact title="替换同名 Skill？" onClose={()=>{if(!pending.current&&!uncertain)setReplacing(null)}} footer={<><button type="button" className="native-settings-button" disabled={busy} onClick={()=>void refresh()}>刷新列表核对</button><button type="button" className="native-settings-button" disabled={busy||uncertain} onClick={()=>{setReplacing(null);setError('')}}>取消替换</button><button type="button" className="native-settings-button is-danger" disabled={busy||uncertain} onClick={()=>{const draft=replacing;void mutate(()=>client.importText(draft.source,{overwrite:true}),'Skill 已替换。',()=>setReplacing(null))}}>确认替换</button></>}>
      <p>当前账号已有「{replacing.name}」。确认后将用所选 SKILL.md 的说明和正文替换已有内容，此操作无法撤销。取消会保留原技能。</p>
      {error&&<p role="alert" className="native-settings-notice is-error">{error}</p>}
    </NativeSettingsDialog>}
    {removing&&<NativeSettingsDialog compact title="删除 Skill" onClose={()=>setRemoving(null)} footer={<><button type="button" className="native-settings-button" onClick={()=>setRemoving(null)}>取消</button><button type="button" className="native-settings-button is-danger" disabled={busy||uncertain} onClick={()=>{const name=removing.name;void mutate(()=>client.removeSkill(name),'Skill 已删除。',()=>setSkills(items=>items.filter(skill=>skill.name!==name)))}}>确认删除</button></>}><p>确定从当前账号删除「{removing.name}」？此操作无法撤销。</p></NativeSettingsDialog>}
  </section>
}
