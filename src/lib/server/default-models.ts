/**
 * Environment-backed Pi defaults. A complete custom model catalog can be
 * supplied as one-line JSON in PI_WEB_MODELS_JSON.
 */
export const DEFAULT_PROVIDER = process.env.PI_WEB_DEFAULT_PROVIDER?.trim() || 'keva';
export const DEFAULT_MODEL = process.env.PI_WEB_DEFAULT_MODEL?.trim() || 'qwen3.6-35b-a3b';
type DefaultThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const THINKING_LEVELS: DefaultThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max'
];

function defaultThinkingFromEnv(): DefaultThinkingLevel {
	const value = process.env.PI_WEB_DEFAULT_THINKING?.trim() || 'high';
	if ((THINKING_LEVELS as string[]).includes(value)) return value as DefaultThinkingLevel;
	throw new Error(`PI_WEB_DEFAULT_THINKING has unsupported value "${value}".`);
}

export const DEFAULT_THINKING = defaultThinkingFromEnv();

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
					input: ['text', 'image'],
					contextWindow: 262144,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the model catalog exclusively from the process environment. */
export function modelsConfigFromEnv(): unknown {
	const raw = process.env.PI_WEB_MODELS_JSON?.trim();
	if (!raw) return DEFAULT_MODELS_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`PI_WEB_MODELS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new Error('PI_WEB_MODELS_JSON must contain a top-level "providers" object.');
	}
	return parsed;
}
