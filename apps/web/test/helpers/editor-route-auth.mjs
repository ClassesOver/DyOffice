import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'
import {authError} from '../../server/src/modules/auth/sessions.ts'

export function editorRouteAuth(){
 const origin='https://office.test'
 const csrf=createCsrfService({deploymentId:'editor-route-test',origin,key:'test editor route key, never deployed'})
 const token=csrf.sessionCredentials.issue()
 const headers={origin,cookie:`${SESSION_COOKIE}=${token}`,'x-csrf-token':csrf.sessionToken(token)}
 const sessions={async authenticate(value){if(value!==token)throw authError()}}
 return {token,headers,sessions,csrf}
}
