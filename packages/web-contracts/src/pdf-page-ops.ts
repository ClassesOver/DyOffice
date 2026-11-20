export type PdfPageOperation =
 | {readonly op:'setMetadata';readonly metadata:Readonly<Partial<Record<'title'|'author'|'subject'|'keywords',string>>>|null}
 | {readonly op:'rotatePages';readonly pages:readonly number[];readonly dir:-90|90|180}
 | {readonly op:'deletePage';readonly page:number}
 | {readonly op:'setPageOrder';readonly order:readonly number[]|null}
 | {readonly op:'insertBlankPage';readonly afterPage:number}
 | {readonly op:'setPageSize';readonly width:number;readonly height:number}
 | {readonly op:'cropPages';readonly pages:readonly number[];readonly left:number;readonly top:number;readonly right:number;readonly bottom:number}

function fail(code:string):never{throw Object.assign(new Error(code),{code})}
const page=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=100
const pageList=(value:unknown):value is number[]=>Array.isArray(value)&&value.length>=1&&value.length<=100&&Reflect.ownKeys(value).length===value.length+1&&value.every(page)&&new Set(value).size===value.length

export function validatePdfPageOperations(value:unknown,pageCount?:number):readonly PdfPageOperation[]{
 if(!Array.isArray(value)||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_PAGE_OPS')
 const operations:PdfPageOperation[]=[]
 for(let index=0;index<value.length;index++){
  const property=Object.getOwnPropertyDescriptor(value,String(index)),item=property?.value
  if(!property||!('value'in property)||!property.enumerable||!item||typeof item!=='object'||Array.isArray(item)||![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('INVALID_PDF_PAGE_OPS')
  for(const key of Reflect.ownKeys(item)){const property=Object.getOwnPropertyDescriptor(item,key);if(!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_PAGE_OPS')}
  const shape: string|undefined=({setMetadata:'metadata,op',rotatePages:'dir,op,pages',deletePage:'op,page',setPageOrder:'op,order',insertBlankPage:'afterPage,op',setPageSize:'height,op,width',cropPages:'bottom,left,op,pages,right,top'} as Record<string,string>)[item.op]
  if(!shape||Reflect.ownKeys(item).some(key=>typeof key!=='string')||Object.keys(item).sort().join(',')!==shape)fail('INVALID_PDF_PAGE_OPS')
  if(item.op==='setMetadata'){
   const given=item.metadata,metadata:Partial<Record<'title'|'author'|'subject'|'keywords',string>>={}
   if(given!==null){
    if(!given||typeof given!=='object'||Array.isArray(given)||![Object.prototype,null].includes(Object.getPrototypeOf(given)))fail('INVALID_PDF_PAGE_OPS')
    for(const key of Reflect.ownKeys(given)){
     const property=Object.getOwnPropertyDescriptor(given,key)
     if(typeof key!=='string'||!['title','author','subject','keywords'].includes(key)||!property||!('value'in property)||!property.enumerable||typeof property.value!=='string'||property.value.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(property.value))fail('INVALID_PDF_PAGE_OPS')
     metadata[key as keyof typeof metadata]=property.value.trim()
    }
   }
   operations.push(Object.freeze({op:item.op,metadata:given===null?null:Object.freeze(metadata)}))
  }else if(item.op==='rotatePages'){
   if(!pageList(item.pages)||![-90,90,180].includes(item.dir))fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,pages:Object.freeze([...item.pages]),dir:item.dir}))
  }else if(item.op==='deletePage'){
   if(!page(item.page))fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,page:item.page}))
  }else if(item.op==='setPageOrder'){
   if(item.order!==null&&!pageList(item.order))fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,order:item.order===null?null:Object.freeze([...item.order])}))
  }else if(item.op==='setPageSize'){
   if(![item.width,item.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=72&&value<=14400))fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,width:item.width,height:item.height}))
  }else if(item.op==='cropPages'){
   if(!pageList(item.pages)||![item.left,item.top,item.right,item.bottom].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1)||item.left>=item.right||item.top>=item.bottom||item.left===0&&item.top===0&&item.right===1&&item.bottom===1)fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,pages:Object.freeze([...item.pages]),left:item.left,top:item.top,right:item.right,bottom:item.bottom}))
  }else{
   if(!Number.isSafeInteger(item.afterPage)||item.afterPage<0||item.afterPage>100)fail('INVALID_PDF_PAGE_OPS')
   operations.push(Object.freeze({op:item.op,afterPage:item.afterPage}))
  }
 }
 if(operations.some(operation=>operation.op==='setPageSize'||operation.op==='cropPages')&&operations.length!==1)fail('INVALID_PDF_PAGE_OPS')
 if(pageCount!==undefined){
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>100)fail('INVALID_PDF_PAGE_OPS')
  const deleted=new Set<number>(),inserts:number[]=[]
  let order:readonly number[]|null=null
  for(const operation of operations){
   if(operation.op==='rotatePages'||operation.op==='cropPages'){if(operation.pages.some(page=>page>pageCount||deleted.has(page)))fail('INVALID_PDF_PAGE_OPS')}
   else if(operation.op==='deletePage'){if(operation.page>pageCount||deleted.has(operation.page))fail('INVALID_PDF_PAGE_OPS');deleted.add(operation.page)}
   else if(operation.op==='setPageOrder'){
    const current=Array.from({length:pageCount},(_,index)=>index+1).filter(page=>!deleted.has(page))
    if(operation.order!==null&&(operation.order.length!==current.length||current.some(page=>!operation.order!.includes(page))))fail('INVALID_PDF_PAGE_OPS')
    order=operation.order
   }
   else if(operation.op==='insertBlankPage'){if(operation.afterPage>pageCount)fail('INVALID_PDF_PAGE_OPS');inserts.push(operation.afterPage)}
  }
  if(order!==null)order=order.filter(page=>!deleted.has(page))
  const remaining=Array.from({length:pageCount},(_,index)=>index+1).filter(page=>!deleted.has(page))
  if(!remaining.length||order!==null&&(order.length!==remaining.length||remaining.some(page=>!order.includes(page))||order.some(page=>deleted.has(page)||page>pageCount))||inserts.some(page=>deleted.has(page)))fail('INVALID_PDF_PAGE_OPS')
  if(remaining.length+inserts.length>100)fail('PDF_EDIT_LIMIT')
 }
 return Object.freeze(operations)
}
