import {useEffect,useId,useRef,useState,type ReactNode} from 'react'
import {SettingsListPager} from './SettingsListPager'
import './management-list.css'

type ManagementColumn<RecordType>={title:ReactNode;key?:string;dataIndex?:keyof RecordType;width?:number|string;render?:(value:any,record:RecordType,index:number)=>ReactNode}
type ManagementListProps<RecordType extends object>={
 heading?:string;description?:string;summary:ReactNode;toolbar:ReactNode;panel?:ReactNode;footer?:ReactNode;scrollX?:number
 rowKey:keyof RecordType|((record:RecordType)=>string);loading?:boolean;dataSource?:readonly RecordType[];columns?:readonly ManagementColumn<RecordType>[];locale?:{emptyText?:ReactNode}
 pagination?:{current?:number;pageSize?:number;total?:number;disabled?:boolean;onChange?:(page:number,pageSize:number)=>void}
}
/** Native table with a bounded scrolling region; operations remain owned by callers. */
export function ManagementList<RecordType extends object>({heading,description,summary,toolbar,panel,footer,pagination,scrollX=720,rowKey,loading=false,dataSource=[],columns=[],locale}:ManagementListProps<RecordType>){
 const headingId=useId()
 const region=useRef<HTMLDivElement>(null),[height,setHeight]=useState(240)
 useEffect(()=>{
  const element=region.current;if(!element)return
  const update=(size:number)=>{if(size>0)setHeight(Math.max(80,Math.floor(size)-2))}
  update(element.getBoundingClientRect().height)
  const observer=new ResizeObserver(entries=>{const entry=entries.find(item=>item.target===element);if(entry)update(entry.contentRect.height)})
  observer.observe(element);return()=>observer.disconnect()
 },[])
 return <div className="management-list settings-list-surface">
  {heading&&<header className="management-list-heading"><h3 id={headingId}>{heading}</h3>{description&&<p className="management-list-description">{description}</p>}</header>}
  <div className="management-list-summary">{summary}</div>
  <div className="management-list-toolbar">{toolbar}</div>
  {panel&&<div className="management-list-panel">{panel}</div>}
  <div className="management-list-table-region" ref={region} role={heading?'region':undefined} aria-labelledby={heading?headingId:undefined} aria-busy={loading}>
   <div className="management-list-table-scroll" style={{maxHeight:height}} tabIndex={0} aria-label={heading?`${heading}表格`:'数据表格'}><table className="management-list-table" style={{minWidth:dataSource.length?scrollX:undefined}}><thead><tr>{columns.map((column,index)=><th scope="col" key={column.key??String(column.dataIndex??index)} style={{width:column.width}}>{column.title}</th>)}</tr></thead><tbody>{dataSource.length?dataSource.map((record,index)=>{const key=String(typeof rowKey==='function'?rowKey(record):record[rowKey]);return <tr key={key} data-row-key={key}>{columns.map((column,columnIndex)=>{const value=column.dataIndex===undefined?undefined:record[column.dataIndex];return <td key={column.key??String(column.dataIndex??columnIndex)}>{column.render?column.render(value,record,index):value as ReactNode}</td>})}</tr>}):<tr><td className="management-list-empty" colSpan={Math.max(columns.length,1)}>{locale?.emptyText??'暂无数据'}</td></tr>}</tbody></table></div>
  </div>
  {(pagination||footer)&&<div className="management-list-footer">{footer}{pagination&&<SettingsListPager label={heading??'数据'} page={(pagination.current??1)-1} pageSize={pagination.pageSize??10} total={pagination.total??0} disabled={pagination.disabled} onPageChange={page=>pagination.onChange?.(page+1,pagination.pageSize??10)}/>}</div>}
 </div>
}
