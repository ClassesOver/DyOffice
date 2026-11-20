import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const directoryVariables={
 docs:'DYOFFICE_TEST_NATIVE_DOCS_DIST',
 sheets:'DYOFFICE_TEST_SHEETS_DIST',
 slides:'DYOFFICE_TEST_SLIDES_DIST',
 pdf:'DYOFFICE_TEST_NATIVE_PDF_DIST',
 'local-shell':'DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY',
}

export function officeBrowserAsset(name,env=process.env){
 return env[directoryVariables[name]]??(env.DYOFFICE_TEST_OFFICE_ASSETS
  ?join(env.DYOFFICE_TEST_OFFICE_ASSETS,name)
  :fileURLToPath(new URL('../../dist-'+name,import.meta.url)))
}
