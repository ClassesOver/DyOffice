import { PDFDocument, TextRenderingMode, degrees, popGraphicsState, pushGraphicsState, rgb, setLineWidth, setStrokingColor, setTextRenderingMode } from 'pdf-lib'
import { pdfFontkit } from './pdf-fontkit'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 52
const BLOCK_TAG = /^(DIV|SECTION|ARTICLE|P|H[1-6]|PRE|BLOCKQUOTE|UL|OL|TABLE)$/

type TextStyle = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }
type TextRun = { text: string; style: TextStyle }
type PdfBlock = { type: 'text'; runs: TextRun[]; size: number; indent: number; pre?: boolean } | { type: 'table'; rows: TextRun[][][] }

function readRuns(nodes: Iterable<Node>, pre = false, style: TextStyle = {}): TextRun[] {
  const runs: TextRun[] = []
  const visit = (node: Node, inherited: TextStyle) => {
    if (node.nodeType === 3) {
      const raw = node.textContent ?? ''
      const text = pre ? raw.replace(/\t/g, '    ') : raw.replace(/[\t\n\f\r ]+/g, ' ')
      if (text) runs.push({ text, style: inherited })
      return
    }
    if (node.nodeType !== 1) return
    const tag = (node as Element).tagName.toLowerCase()
    if (tag === 'br') { runs.push({ text: '\n', style: inherited }); return }
    const next = tag === 'b' || tag === 'strong' ? { ...inherited, bold: true }
      : tag === 'i' || tag === 'em' ? { ...inherited, italic: true }
      : tag === 'u' ? { ...inherited, underline: true }
      : tag === 's' || tag === 'strike' || tag === 'del' ? { ...inherited, strike: true }
      : inherited
    for (const child of Array.from(node.childNodes)) visit(child, next)
  }
  for (const node of nodes) visit(node, style)
  return runs
}

function htmlBlocks(html: string): PdfBlock[] {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  for (const element of body.querySelectorAll('script,style,iframe,object,embed,svg,math,noscript,template')) element.remove()
  const blocks: PdfBlock[] = []
  const addText = (nodes: Iterable<Node>, size: number, indent: number, pre = false, style: TextStyle = {}) => {
    const runs = readRuns(nodes, pre, style)
    if (runs.some(run => run.text.trim() || run.text.includes('\n'))) blocks.push({type:'text',runs,size,indent,pre})
  }
  const visit = (element: Element, indent = 0) => {
    const tag = element.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      addText(Array.from(element.childNodes),Math.max(12,20-(level-1)*2),indent,false,{bold:true})
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      let index = 0
      for (const item of Array.from(element.children).filter(child => child.tagName.toLowerCase() === 'li')) {
        index += 1
        const nested = Array.from(item.children).filter(child => ['ul','ol'].includes(child.tagName.toLowerCase()))
        const runs=readRuns(Array.from(item.childNodes).filter(node => !nested.includes(node as Element)))
        if (runs.some(run=>run.text.trim())) blocks.push({type:'text',runs:[{text:`${tag === 'ol' ? `${index}.` : '-'} `,style:{}},...runs],size:11,indent})
        for (const child of nested) visit(child,indent+16)
      }
      return
    }
    if (tag === 'table') {
      const rows = Array.from(element.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll(':scope > th, :scope > td'))
        .map(cell => readRuns(Array.from(cell.childNodes),false,cell.tagName==='TH'?{bold:true}:{}))).filter(row => row.length)
      if (rows.length) blocks.push({type:'table',rows})
      return
    }
    if (['p','blockquote','pre','li'].includes(tag)) {
      addText(Array.from(element.childNodes),tag==='pre'?9.5:11,indent+(tag==='blockquote'?10:0),tag==='pre')
      return
    }
    if (Array.from(element.children).some(child => BLOCK_TAG.test(child.tagName))) {
      visitContainer(element,indent)
    } else addText([element],11,indent)
  }
  const visitContainer = (element: Element, indent: number) => {
    let inline: Node[] = []
    const flush = () => { addText(inline,11,indent); inline=[] }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType===1&&BLOCK_TAG.test((child as Element).tagName)) {
        flush()
        visit(child as Element,indent)
      } else inline.push(child)
    }
    flush()
  }
  visitContainer(body,0)
  return blocks
}

export async function createAiPdf(title: string, html: string, fontBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title.trim() || 'Untitled')
  pdf.registerFontkit(pdfFontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  const titleFontSize = 18
  const lineHeight = 17
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN
  const addPage = () => { page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = PAGE_HEIGHT - MARGIN }
  const color=rgb(0.12,0.16,0.2)
  const linesOf = (runs: TextRun[], size: number, maxWidth: number, pre = false) => {
    const lines: TextRun[][]=[]
    const widths=new Map<string,number>()
    let line: TextRun[]=[],width=0,space: TextStyle | undefined
    const nextLine = () => { lines.push(line); line=[]; width=0; space=undefined }
    const measure = (char: string) => {
      let length=widths.get(char)
      if(length===undefined){length=font.widthOfTextAtSize(char,size);widths.set(char,length)}
      return length
    }
    const append = (char: string, style: TextStyle) => {
      const length=measure(char)
      const last=line.at(-1)
      if(last?.style===style)last.text+=char
      else line.push({text:char,style})
      width+=length
    }
    for(const {text,style} of runs)for(const char of text){
      if(char==='\n'){nextLine();continue}
      if(!pre&&char===' '){if(line.length&&!space)space=style;continue}
      if(line.length&&width+measure(char)+(space?measure(' '):0)>maxWidth)nextLine()
      if(space){append(' ',space);space=undefined}
      append(char,style)
    }
    lines.push(line)
    return lines
  }
  const drawLine = (line: TextRun[], x: number, baseline: number, size: number) => {
    for(const {text,style} of line){
      if(style.bold)page.pushOperators(pushGraphicsState(),setStrokingColor(color),setLineWidth(size*0.025),setTextRenderingMode(TextRenderingMode.FillAndOutline))
      page.drawText(text,{x,y:baseline,size,font,color,...(style.italic?{ySkew:degrees(12)}:{})})
      if(style.bold)page.pushOperators(popGraphicsState())
      const end=x+font.widthOfTextAtSize(text,size)
      for(const offset of [...(style.underline?[-size*0.13]:[]),...(style.strike?[size*0.3]:[])])
        page.drawLine({start:{x,y:baseline+offset},end:{x:end,y:baseline+offset},thickness:size*0.055,color})
      x=end
    }
  }
  const drawWrapped = (runs: TextRun[], size: number, indent = 0, pre = false) => {
    const advance = Math.max(lineHeight,size*1.4)
    for(const line of linesOf(runs,size,PAGE_WIDTH-MARGIN*2-indent,pre)){
      if (y < MARGIN) addPage()
      drawLine(line,MARGIN+indent,y,size)
      y -= advance
    }
  }
  drawWrapped([{text:title.trim() || '未命名',style:{}}], titleFontSize)
  for (const block of htmlBlocks(html)) {
    if (block.type === 'text') {
      drawWrapped(block.runs, block.size, block.indent, block.pre)
      if (block.size > 11) y -= 4
      continue
    }
    const columns = Math.max(...block.rows.map(row => row.length))
    const columnWidth = (PAGE_WIDTH - MARGIN * 2) / columns
    for (const row of block.rows) {
      const cells = Array.from({length:columns},(_,index)=>row[index]??[])
      const cellLines = cells.map(value => linesOf(value,10,columnWidth-10))
      const lineCount = Math.max(...cellLines.map(lines=>lines.length))
      let offset = 0
      while(offset < lineCount){
        if(y-MARGIN<22)addPage()
        const count=Math.min(lineCount-offset,Math.floor((y-MARGIN-8)/14))
        const rowHeight=count*14+8
        cells.forEach((_value,index)=>{
          const x=MARGIN+index*columnWidth
          page.drawRectangle({x,y:y-rowHeight,width:columnWidth,height:rowHeight,borderColor:rgb(0.55,0.58,0.62),borderWidth:0.5})
          cellLines[index]!.slice(offset,offset+count).forEach((line,lineIndex)=>drawLine(line,x+5,y-13-lineIndex*14,10))
        })
        y-=rowHeight;offset+=count
        if(offset<lineCount)addPage()
      }
    }
    y -= 8
  }
  return pdf.save()
}
