import {Pagination,Table,type PaginationProps,type TableProps} from 'antd'
import {useEffect,useId,useRef,useState,type ReactNode} from 'react'
import './management-list.css'
import './settings-primitives.css'

type ManagementListProps<RecordType extends object> = Omit<TableProps<RecordType>,'pagination'|'scroll'|'title'|'footer'|'summary'> & {
 heading?:string;description?:string;summary:ReactNode;toolbar:ReactNode;panel?:ReactNode;footer?:ReactNode;pagination?:PaginationProps;scrollX?:number
}
export function ManagementList<RecordType extends object>({heading,description,summary,toolbar,panel,footer,pagination,scrollX=720,...table}:ManagementListProps<RecordType>){
 const headingId=useId()
 const region=useRef<HTMLDivElement>(null),[height,setHeight]=useState(240)
 useEffect(()=>{
  const element=region.current;if(!element)return
  const update=(size:number)=>{if(size>0)setHeight(Math.max(80,Math.floor(size)-60))}
  update(element.getBoundingClientRect().height)
  const observer=new ResizeObserver(entries=>{const entry=entries.find(item=>item.target===element);if(entry)update(entry.contentRect.height)})
  observer.observe(element);return()=>observer.disconnect()
 },[])
 return <div className="management-list settings-list-surface">
  {heading&&<header className="management-list-heading"><h3 id={headingId}>{heading}</h3>{description&&<p className="management-list-description">{description}</p>}</header>}
  <div className="management-list-summary">{summary}</div>
  <div className="management-list-toolbar">{toolbar}</div>
  {panel&&<div className="management-list-panel">{panel}</div>}
  <div className="management-list-table-region" ref={region} role={heading?'region':undefined} aria-labelledby={heading?headingId:undefined}><Table<RecordType> {...table} size="small" pagination={false} scroll={{x:scrollX,y:height}}/></div>
  {(pagination||footer)&&<div className="management-list-footer">{footer}{pagination&&<Pagination {...pagination}/>}</div>}
 </div>
}
