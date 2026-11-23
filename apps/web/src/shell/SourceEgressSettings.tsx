import React, {useState} from 'react'
import type {SourceEgressTarget} from '../../../../packages/web-contracts/src/settings'

const kinds = {postgres: 'PostgreSQL', mysql: 'MySQL', starrocks: 'StarRocks', http: 'HTTP API'} as const
const examples = {postgres: 'postgresql://db.example.com:5432', mysql: 'mysql://db.example.com:3306', starrocks: 'starrocks://db.example.com:9030', http: 'https://api.example.com/data'}
const newTarget: SourceEgressTarget = {kind: 'starrocks', endpoint: '', addresses: [], username: '', database: '', allowInsecure: true}

export function SourceEgressSettings({targets, onChange, disabled}: {
  targets: SourceEgressTarget[]; onChange: (targets: SourceEgressTarget[]) => void; disabled: boolean
}) {
  const [selected, select] = useState(0)
  const index = Math.min(selected, targets.length - 1)
  const target = targets[index]
  const update = (change: Partial<SourceEgressTarget>) => onChange(targets.map((item, i) => i === index ? {...item, ...change} : item))
  return <div className="global-settings-editor source-egress-settings">
    <div className="global-settings-config-picker">
      <select aria-label="选择允许的目标" disabled={disabled || !target} value={target ? index : ''} onChange={event => select(Number(event.target.value))}>
        {!target && <option value="">暂无允许的目标</option>}
        {targets.map((item, i) => <option key={i} value={i}>{kinds[item.kind]} · {item.endpoint || '新目标'}{item.database ? ' / ' + item.database : ''}</option>)}
      </select>
      <button type="button" disabled={disabled || targets.length >= 256} onClick={() => {select(targets.length); onChange([...targets, {...newTarget}])}}>添加目标</button>
    </div>
    {target && <fieldset disabled={disabled}>
      <label className="global-settings-field"><span>连接类型</span><select value={target.kind} onChange={event => {
        const kind=event.target.value as SourceEgressTarget['kind']
        update({kind,allowInsecure:kind!=='http',ca:undefined})
      }}>
        {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select></label>
      <label className="global-settings-field"><span>目标地址</span><input value={target.endpoint} placeholder={examples[target.kind]} onChange={event => update({endpoint: event.target.value})}/></label>
      <label className="global-settings-field"><span>固定 IP<small>多个地址用逗号分隔</small></span><input aria-label="固定 IP" value={target.addresses.join(',')} placeholder="192.0.2.10" onChange={event => update({addresses: event.target.value.split(/[,，]/)})}/></label>
      {target.kind !== 'http' && <>
        <label className="global-settings-field"><span>数据库名</span><input value={target.database ?? ''} onChange={event => update({database: event.target.value})}/></label>
        <label className="global-settings-field"><span>只读用户名</span><input value={target.username ?? ''} onChange={event => update({username: event.target.value})}/></label>
      </>}
      {target.kind==='http' ? <label className="global-settings-field"><span>允许未加密连接</span><input type="checkbox" checked={target.allowInsecure === true} onChange={event => update({allowInsecure: event.target.checked})}/></label>
        : <label className="global-settings-field"><span>使用 TLS<small>普通连接不加密传输。</small></span><input type="checkbox" checked={target.allowInsecure !== true} onChange={event => update({allowInsecure: !event.target.checked})}/></label>}
      {!target.allowInsecure && <label className="global-settings-field"><span>自定义 CA（可选）</span><textarea rows={3} value={target.ca ?? ''} onChange={event => update({ca: event.target.value})}/></label>}
      <div className="global-settings-entry-actions"><button type="button" data-variant="danger" onClick={() => onChange(targets.filter((_, i) => i !== index))}>移除目标</button></div>
    </fieldset>}
  </div>
}
