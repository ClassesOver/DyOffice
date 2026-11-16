export interface WebConfig {
  directory: string
  userToken: string
  adminToken: string
  encryptionKey: string
  assetMode?: 'source' | 'built'
  assetDirectory?: string
  rateLimit?: { max: number; timeWindow: number }
}
