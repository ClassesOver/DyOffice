/** Shared by local and remote harness transports. No Office session secrets. */
export const HARNESS_DATA_MAX_METADATA_BYTES = 256 * 1024

export interface HarnessDataInputs {sourceIds:string[];resultIds:string[]}
export interface HarnessDataGrant {
  taskId:string;claimId:string;connectionEpoch:1;credential:string
  agentId:string;expiresAt:string;inputs:HarnessDataInputs
}
export type HarnessDataOperation = 'list_connections'|'search_objects'|'execute_sql'|
  'results.get_manifest'|'results.download'|'artifacts.stage'|'artifacts.commit'|'artifacts.get_receipt'
export interface AnalysisInputRef {
  resultId:string;sha256:string;sourceId:string;sourceVersion:number;queryHash:string;rowCount:number;truncated:boolean
}
export interface AnalysisArtifactRef {
  artifactId:string;name:string;mediaType:string;sizeBytes:number;sha256:string
  role:string;inputResultIds:string[]
}
export interface AnalysisDelivery {
  taskId:string;claimId:string;connectionEpoch:number;commandId:string;summary:string;inputs:unknown[];artifacts:AnalysisArtifactRef[]
  runtimeManifestSha256:string;limitations:string[];createdAt:string
}
