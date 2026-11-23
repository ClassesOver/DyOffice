import type {ModelConnectionFailure} from '../../../../../../packages/web-contracts/src/settings.ts'

const guidance: Record<ModelConnectionFailure,string> = {
  PROVIDER_AUTH_REJECTED: 'The model provider rejected authentication. Ask your administrator to check the model settings.',
  PROVIDER_RATE_LIMITED: 'The model provider is rate limited or out of quota. Try again later or choose another model.',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'The model provider is temporarily unavailable. Try again later or choose another model.',
}

/** Only known HTTP outcomes cross the provider boundary, never the response body. */
export class ProviderResponseFailure extends Error {
  constructor(readonly code: ModelConnectionFailure) { super('Provider transport unavailable') }
  get guidance(): string { return guidance[this.code] }
}

export function providerResponseFailure(status: number | undefined): ProviderResponseFailure | undefined {
  if (status === 401 || status === 403) return new ProviderResponseFailure('PROVIDER_AUTH_REJECTED')
  if (status === 429) return new ProviderResponseFailure('PROVIDER_RATE_LIMITED')
  if (status !== undefined && status >= 500 && status <= 599) return new ProviderResponseFailure('PROVIDER_TEMPORARILY_UNAVAILABLE')
}
