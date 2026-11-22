import { z } from 'zod'

/// One link as the read-only listing carries it. Deliberately no `reachable`:
/// listing the links must not probe the targets on disk (a dead network share
/// can block the open), so reachability is answered only by the explicit
/// update.
export const externalLinkListStatusSchema = z
  .object({
    index: z.number().int().positive(),
    rawTarget: z.string(),
    source: z.string().nullable(),
    sheetNames: z.array(z.string()),
  })
  .strict()
export type ExternalLinkListStatus = z.infer<typeof externalLinkListStatusSchema>

/// The panel's non-probing listing (the sidecar's `list_external_links`).
export const externalLinksResultSchema = z
  .object({ links: z.array(externalLinkListStatusSchema), workspaceSources: z.literal(true).optional() })
  .strict()
export type ExternalLinksResult = z.infer<typeof externalLinksResultSchema>
