import { runPptxSessionChild } from './pptx-session.ts'

// Dedicated child-process entry for openIsolatedPptxSession: one untrusted deck,
// one IPC-bound session, one process. Never imported by the API process.
runPptxSessionChild()
