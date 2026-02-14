/**
 * Provider router stub for future multi-provider model routing.
 *
 * Currently all Anthropic models and Mistral models are detected by prefix.
 * This establishes the abstraction point for future provider-specific API routing
 * (e.g., different API clients, auth, rate limits per provider).
 */

export type Provider = 'anthropic' | 'mistral';

export function detectProvider(modelId: string): Provider {
  if (modelId.startsWith('mistral-')) return 'mistral';
  return 'anthropic';
}

export interface ModelConfig {
  id: string;
  provider: Provider;
}

export function resolveModel(modelId: string): ModelConfig {
  return { id: modelId, provider: detectProvider(modelId) };
}
