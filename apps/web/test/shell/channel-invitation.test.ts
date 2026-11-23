import {expect,test} from 'vitest'
import {decodeAgentAction} from '../../../../packages/web-contracts/src/assistant-channel'
import {dshConnectionInstructions,connectionOrigin,isLoopbackOrigin} from '../../src/shell/channel-invitation'

test('connection instructions include the address, invitation, approval and member exchange',()=>{
 const text=dshConnectionInstructions('https://office.example.com','invite-secret','channel-id')
 for(const part of ['https://office.example.com/api/v1/assistant-channels','invite-secret','channel-id','applicationToken','memberToken','批准连接','/redeem','saved-revision'])expect(text).toContain(part)
})
test('connection addresses must be HTTP origins without credentials or extra paths',()=>{
 expect(connectionOrigin(' https://office.example.com/ ')).toBe('https://office.example.com')
 for(const value of ['not-url','javascript:alert(1)','https://user:password@example.com','https://example.com/path','https://example.com/?token=secret','https://example.com/#secret'])expect(connectionOrigin(value)).toBeNull()
 expect(isLoopbackOrigin('http://localhost:3080')).toBe(true)
 expect(isLoopbackOrigin('http://127.0.0.1:3080')).toBe(true)
 expect(isLoopbackOrigin('http://[::1]:3080')).toBe(true)
 expect(isLoopbackOrigin('https://office.example.com')).toBe(false)
})

test('DSH instructions preserve the full member response and stop on rejected requests',()=>{
 const text=dshConnectionInstructions('https://office.example.com','invite-secret','channel-id')
 for(const part of ['完整兑换响应','member.json','redeemed.memberId','redeemed.memberToken','非 200','立即停止','taskId','savedRevision','DOCX、XLSX、PPTX、PDF'])expect(text).toContain(part)
 const examples=text.split('\n').filter(line=>line.startsWith('{"requestId":')).map(line=>JSON.parse(line))
 expect(examples).toHaveLength(2)
 expect(examples.map(example=>example.action.execution)).toEqual([undefined,'saved-revision'])
 expect(text).toContain('/members/<memberId>/tasks')
 expect(text).toContain('创建或编辑文档')
 const id='12345678-1234-1234-1234-123456789abc'
 for(const example of examples){
  const request={...example,requestId:id,conversationId:id,action:{...example.action,instruction:'读取预算'}}
  expect(decodeAgentAction(request)).toEqual(request)
 }
})
