export type ContinuationOrigin={revision:string;modelId:string;callId:string}
export function matchesContinuation(origin:ContinuationOrigin,current:{revision?:string|undefined;modelId?:string|null|undefined;callId?:string|undefined}){
 return origin.revision===current.revision&&origin.modelId===current.modelId&&origin.callId===current.callId
}
