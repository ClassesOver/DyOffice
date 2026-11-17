import {useEffect, useRef, useState} from 'react'
import {parseSkillFrontmatter} from '@genoffice/agent-core'
import {Alert, Button, Card, Input, Modal, Select, Space, Table, Tag} from 'antd'
import {WEB_OFFICE_SKILL_CATALOG} from './office-skill-catalog'
import {classifyOfficeSkill, OFFICE_SKILL_REQUIRED} from './office-skills'
import type {createUserSkillsClient} from './user-skills-client'
import type {FoundSkill} from '../../../shell/src/shared/found-skill'

export function UserSkillsPanel({client,onCloseGuardChange}: {client: ReturnType<typeof createUserSkillsClient>;onCloseGuardChange?:(guard:(()=>boolean)|null)=>void}) {
  const [skills, setSkills] = useState<FoundSkill[]>([])
  const [listed, setListed] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState(''), [catalogFormat, setCatalogFormat] = useState('all'), [catalogPage, setCatalogPage] = useState(1)
  const catalog = WEB_OFFICE_SKILL_CATALOG.filter(skill => (catalogFormat === 'all' || skill.formats.includes(catalogFormat)) && `${skill.key} ${skill.name} ${skill.description}`.toLowerCase().includes(catalogSearch.trim().toLowerCase()))
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [view, setView] = useState<{name: string; body: string} | null>(null)
  const [removing, setRemoving] = useState<FoundSkill | null>(null)
  const input = useRef<HTMLInputElement>(null), pending = useRef(false), generation = useRef(0)
  function canClose() {
    if (pending.current) { setError('Skills 操作处理中，请完成后再关闭。'); return false }
    if (uncertain) { setError('Skills 操作结果未确认，请刷新列表核对后再关闭。'); return false }
    return true
  }
  useEffect(() => {
    onCloseGuardChange?.(busy || uncertain ? canClose : null)
    return () => onCloseGuardChange?.(null)
  }, [onCloseGuardChange, busy, uncertain])
  async function refresh() {
    if (pending.current) return
    const current = generation.current
    pending.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const items = await client.listSkills()
      if (current === generation.current) { setSkills(items); setListed(true); setUncertain(false) }
    } catch { if (current === generation.current) setError('无法读取当前账号的 Skills，请刷新列表重试。') }
    finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  useEffect(() => {
    generation.current++; pending.current = false
    setSkills([]); setListed(false); setView(null); setRemoving(null); setUncertain(false); setError(''); setMessage('')
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
  async function mutate(action: () => Promise<unknown>, success: string, onConfirmed: () => void = () => {}) {
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
      const unknown = status === undefined || status >= 500 || status === 408
      setUncertain(unknown)
      setError(unknown ? '操作结果未确认，请刷新列表核对后再操作；不要重复提交。' : status === 409 ? '同名技能已存在，未覆盖。请刷新当前账号列表核对。' : '操作被拒绝，请核对当前账号权限及 Skill 文件后重试。')
    } finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  async function install(skill: (typeof WEB_OFFICE_SKILL_CATALOG)[number]) {
    if (!listed || pending.current || uncertain || skills.some(item => item.name === skill.key)) return
    let saved: FoundSkill
    await mutate(async () => { saved = await client.importText(skill.source, {overwrite:false}) }, 'Skill 已添加到当前账号。', () => setSkills(items => [...items.filter(item => item.name !== saved.name), saved]))
  }
  async function importFile(file: File) {
    if (pending.current || uncertain) return
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
    await mutate(() => client.importText(source), 'Skill 已导入当前账号。')
  }
  return <Card title="个人技能">
    <Space wrap style={{marginBottom:16}}><Button autoInsertSpace={false} disabled={busy} onClick={() => void refresh()}>刷新列表</Button><Button autoInsertSpace={false} type="primary" disabled={busy || uncertain} onClick={() => input.current?.click()}>导入 SKILL.md</Button></Space>
    <p>导入说明用于指导已有工具，不会安装程序或开通额外能力；实际可用操作以当前编辑器和账号配置为准。</p>
    <h4>可安装的办公技能</h4>
    <p>从 DyOffice 推荐任务中选择，点击安装后才保存到当前账号；已有同名技能不会覆盖。</p>
    <Space wrap style={{marginBottom:16}}><Input.Search aria-label="搜索可安装技能" placeholder="搜索技能名称或说明" value={catalogSearch} allowClear onChange={event => {setCatalogSearch(event.target.value); setCatalogPage(1)}}/><Select aria-label="筛选技能格式" value={catalogFormat} onChange={value => {setCatalogFormat(value); setCatalogPage(1)}} options={[{value:'all',label:'全部格式'},...['docx','xlsx','pptx','pdf'].map(value => ({value,label:value.toUpperCase()}))]}/></Space>
    <Table rowKey="key" dataSource={catalog} pagination={{current:catalogPage,pageSize:6,showSizeChanger:false,onChange:setCatalogPage}} locale={{emptyText:'没有匹配的办公技能'}} columns={[
      {title:'技能',key:'skill',render:(_value,skill) => <><strong>{skill.name}</strong><p>{skill.description}</p><Space wrap>{skill.formats.map(format => <Tag key={format}>{format.toUpperCase()}</Tag>)}</Space></>},
      {title:'操作',key:'actions',render:(_value,skill) => <Space><Button autoInsertSpace={false} onClick={() => setView({name:skill.name,body:parseSkillFrontmatter(skill.source)?.body ?? skill.source})}>查看正文</Button><Button autoInsertSpace={false} disabled={!listed || busy || uncertain || skills.some(item => item.name === skill.key)} onClick={() => void install(skill)}>{skills.some(item => item.name === skill.key) ? '已添加' : '安装'}</Button></Space>},
    ]}/>
    <h4>当前账号的办公技能</h4>
    <p>支持不超过 256 KiB、包含 name、description 和正文的 SKILL.md。其他类别的旧记录保留，但不在此处或助手技能列表中展示。</p>
    <input ref={input} type="file" accept=".md,text/markdown" hidden aria-label="导入 Skill 文件" onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file)}}/>
    {error && <Alert type="error" showIcon title={error}/>}
    {message && <Alert type="success" showIcon title={message} role="status"/>}
    <Table rowKey="name" loading={busy} pagination={false} dataSource={skills} locale={{emptyText:'尚未导入办公技能'}} columns={[
      {title:'名称',dataIndex:'name',key:'name',render:(name:string) => <>{WEB_OFFICE_SKILL_CATALOG.find(skill => skill.key === name)?.name ?? name}<div>{name}</div></>},
      {title:'说明',dataIndex:'description',key:'description'},
      {title:'操作',key:'actions',render:(_value: unknown, skill: FoundSkill) => <Space><Button autoInsertSpace={false} disabled={busy} onClick={() => void read(skill)}>查看</Button><Button autoInsertSpace={false} danger disabled={busy || uncertain} onClick={() => setRemoving(skill)}>删除</Button></Space>},
    ]}/>
    {view && <Modal title={`Skill：${view.name}`} open={true} destroyOnHidden onCancel={() => setView(null)} footer={<Button autoInsertSpace={false} onClick={() => setView(null)}>关闭</Button>}>
      {view && <Input.TextArea aria-label="Skill 内容" value={view.body} readOnly rows={16}/>}
      {error && <Alert type="error" showIcon title={error}/>}
    </Modal>}
    <Modal title="删除 Skill" open={!!removing} destroyOnHidden onCancel={() => setRemoving(null)} footer={<Space><Button autoInsertSpace={false} onClick={() => setRemoving(null)}>取消</Button><Button autoInsertSpace={false} danger type="primary" disabled={busy || uncertain} onClick={() => {if (removing) {const name = removing.name; void mutate(() => client.removeSkill(name), 'Skill 已删除。', () => setSkills(items => items.filter(skill => skill.name !== name)))}}}>确认删除</Button></Space>}>
      <p>确定从当前账号删除「{removing?.name}」？此操作无法撤销。</p>
    </Modal>
  </Card>
}
