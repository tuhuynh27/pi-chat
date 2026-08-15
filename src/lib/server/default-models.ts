/**
 * Built-in fallback catalog for fresh installs, including the Docker image.
 * A user-provided ~/.pi/agent/models.json still takes precedence.
 */
export const DEFAULT_PROVIDER = 'keva';
export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
export const DEFAULT_THINKING = 'low';

export const DEFAULT_MODELS_CONFIG = {
	providers: {
		keva: {
			name: 'Keva LLM',
			baseUrl: 'https://llm.keva.dev/v1',
			api: 'openai-completions',
			apiKey: '$KEVA_API_KEY',
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: 'max_tokens'
			},
			models: [
				{
					id: 'qwen3.6-35b-a3b',
					name: 'Qwen 3.6 35B A3B',
					reasoning: true,
					input: ['text'],
					contextWindow: 131072,
					maxTokens: 16384,
					cost: {
						input: 0.1,
						output: 0.3,
						cacheRead: 0.01,
						cacheWrite: 0.1
					}
				},
				{
					id: 'qwen3.8-27b',
					name: 'Qwen 3.8 27B',
					reasoning: true,
					input: ['text'],
					contextWindow: 131072,
					maxTokens: 16384,
					cost: {
						input: 0.1,
						output: 0.3,
						cacheRead: 0.01,
						cacheWrite: 0.1
					}
				}
			]
		}
	}
} as const;
