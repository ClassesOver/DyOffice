import {Button} from 'antd'
import './settings-primitives.css'

/** Presentation only: callers retain ownership, permissions and fetch lifecycle. */
export function SettingsListPager({page,pageSize,total,hasPrevious,hasNext,onPageChange,label,disabled=false}:{
 page:number;pageSize:number;total?:number;hasPrevious?:boolean;hasNext?:boolean;onPageChange:(page:number)=>void;label:string;disabled?:boolean
}){
 const lastPage=total===undefined?undefined:Math.max(0,Math.ceil(total/pageSize)-1)
 const current=lastPage===undefined?Math.max(page,0):Math.min(Math.max(page,0),lastPage)
 const previous=hasPrevious??current>0
 const next=hasNext??(lastPage!==undefined&&current<lastPage)
 return <nav className="settings-list-pager" aria-label={`${label}分页`}>
  <Button htmlType="button" autoInsertSpace={false} aria-label={`上一页${label}`} disabled={disabled||!previous} onClick={()=>onPageChange(current-1)}>上一页</Button>
  <span className="settings-list-page-status" aria-live="polite" aria-atomic="true">{total===undefined?`第 ${current+1} 页`:`${total?current*pageSize+1:0}–${Math.min((current+1)*pageSize,total)} / ${total}`}</span>
  <Button htmlType="button" autoInsertSpace={false} aria-label={`下一页${label}`} disabled={disabled||!next} onClick={()=>onPageChange(current+1)}>下一页</Button>
 </nav>
}
