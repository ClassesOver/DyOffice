import {channelBase} from './background-workspace'

export function connectionOrigin(value:string):string|null{
 try{
  const url=new URL(value.trim())
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null
  return url.origin
 }catch{return null}
}
export function isLoopbackOrigin(origin:string):boolean{
 const hostname=new URL(origin).hostname
 return hostname==='localhost'||hostname.endsWith('.localhost')||hostname==='[::1]'||hostname.startsWith('127.')
}
export function dshConnectionInstructions(origin:string,inviteToken:string,conversationId:string):string{
 const base=origin+channelBase
 return `请使用你自己的 Shell / HTTP 工具连接我的 DyOffice，无需安装插件或 genoffice。
服务地址：${origin}
API 基地址：${base}
频道 ID：${conversationId}
一次性邀请码：${inviteToken}

1. 先确认服务可达：GET ${origin}/api/v1/health/ready。若无法访问，告诉我具体错误，不要声称已连接。localhost / 127.0.0.1 / ::1 仅适用于同机或已建立的本机隧道。
2. POST ${base}/applications，Content-Type: application/json，正文：
${JSON.stringify({inviteToken,name:'我的 DSH',kind:'dsh'})}
私密保存返回的 applicationId 和 applicationToken，不要重复使用一次性邀请码。
3. 提醒我进入 DyOffice → 个人工作区 → 频道分享，点击“批准连接”。批准前不要发起任务。
可以用 Authorization: Bearer <applicationToken> 查询 GET ${base}/applications/<applicationId>；获准后 POST ${base}/applications/<applicationId>/redeem，使用相同 Authorization，JSON 正文为 {}。
4. 将完整兑换响应原样私密保存为 member.json，不要只保存 token 或另套一层对象。每次请求前重新读取为 redeemed，使用顶层 redeemed.memberId 构造成员路径、redeemed.memberToken 作为凭证；缺少任一字段立即停止，绝不发送 /members/undefined/ 请求。后续成员请求使用 Authorization: Bearer <memberToken>，不要使用我的登录 Cookie，不要在回答或日志中展示凭证。
5. 兑换凭证表示已授权。使用成员凭证查询 GET ${base}/members/<memberId>/tasks 验证授权。若我明确要求保持在线，由 DSH 常驻进程 POST ${base}/members/<memberId>/connect，JSON 正文为 {"connectionId":"<新 UUID>"}，然后每 15 秒请求一次成员任务列表。停止轮询约 45 秒后会显示离线；连接丢失后需重新 connect。凭证失效或被移除时停止并告知我。
6. 收到任务后先判断是否需要写入。外部成员只能请求读取；若我要求创建或编辑文档（例如创建一份 Word），请让我在 DyOffice 的 Office 助手中发起，不提交成员任务。
普通读取由连接该频道的 Office 编辑器处理。请先确认我已打开并连接相应文档，再 POST ${base}/members/<memberId>/actions：
${JSON.stringify({requestId:'<新 UUID；重试保持不变>',conversationId,to:'office',action:{kind:'delegate',instruction:'<我的具体读取要求>'}})}
仅当我明确要求后台读取，且已在频道中为关联的 DOCX、XLSX、PPTX、PDF 文档开启“允许后台读取已保存版本”时，才用下面的后台读取请求：
${JSON.stringify({requestId:'<新 UUID；重试保持不变>',conversationId,to:'office',action:{kind:'delegate',instruction:'<我的具体任务要求>',execution:'saved-revision'}})}
每个请求都必须检查 HTTP 状态；非 200 时立即停止当前操作，报告实际状态码和失败步骤，不改写任务动作或尝试其他接口。提交成功后保存返回的 taskId，再使用成员凭证查询 GET ${base}/members/<memberId>/tasks/<taskId>，轮询同一 taskId 至结束，私密保存完整任务响应。最终输出服务实际返回的 taskId、state、summary，以及存在时的 savedRevision；不把失败说成成功。
邀请码过期时请我重新生成；申请被拒绝或成员被移除时停止连接。`
}
