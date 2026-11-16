export function sheetsSaveRequest(sheetId, edits) {
  return {
    sessionId:'5d4f6f7a-1c2b-4e3d-9a8f-0b1c2d3e4f5a', mode:'save', edits:edits.map(edit=>({sheetId,...edit})),
    structuralOps:[],chartEdits:[],visualEdits:[],visualAdditions:[],tableAdditions:[],pivotAdditions:[],sheetOps:[],sheetOrder:[sheetId],filterStates:[],hyperlinkEdits:[],cfStates:[],dvStates:[],pageSetupStates:[],noteStates:[],formulaValues:[],pivotCacheRefreshPaths:[],pivotRefreshUpdates:[],sheetProtections:[],sparklineAdditions:[],definedNamesState:null,
  }
}
