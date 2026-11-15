import type { BusinessPrincipal } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
export function authorize(principal: BusinessPrincipal, action: 'workspace:read' | 'preferences:read' | 'preferences:write', resource: { deploymentId: string; ownerId: string }) {
  // Configuration administration never grants ownership of another user's data.
  if (principal.deploymentId !== resource.deploymentId || principal.userId !== resource.ownerId || !principal.scopes.includes(action)) throw authError(404)
}
