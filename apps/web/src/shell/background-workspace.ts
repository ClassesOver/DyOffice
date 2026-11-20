import type {ChannelTask} from '../../../../packages/web-contracts/src/assistant-channel'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
export type WorkspaceRequest=SettingsRequest
export const channelBase='/api/v1/assistant-channels'
export interface ChannelEntry {conversationId:string;fileId:string|null;fileName?:string;paused:boolean;backgroundEnabled?:boolean;createdAt:string}
export interface BackgroundTask extends ChannelTask {fileId:string;fileName:string;sourceName?:string;createdAt:string}
export const backgroundTaskLabels:Record<string,string>={queued:'排队中',running:'执行中',waiting_peer:'等待协作方',cancel_requested:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消',unknown_outcome:'结果待核对'}
