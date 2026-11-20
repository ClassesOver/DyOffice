export const pdfReplacePagesSafetyCodes:Set<string>
export function validatePdfReplacePages(input:unknown):number[]
export function parsePdfReplacePagesRequest(raw:unknown):number[]
export function framePdfReplacePages(target:Buffer,source:Buffer):Buffer
export function splitPdfReplacePagesFrame(frame:Buffer):{target:Buffer;source:Buffer}
export function createPdfReplacePagesJob():{execute(input:Buffer,raw:string,signal?:AbortSignal):Promise<{bytes:Buffer;inputSha256:string;sourceSha256:string;sha256:string;size:number}>}
