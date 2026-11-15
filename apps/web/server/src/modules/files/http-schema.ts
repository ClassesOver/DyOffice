export const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const
export const fileParamsSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } } as const
export const emptyQuerySchema = { type: 'object', additionalProperties: false, properties: {} } as const
