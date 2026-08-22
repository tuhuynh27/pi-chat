import { DEFAULT_MODELS_CONFIG } from './default-models.ts';

const KEVA_CATALOG_URL = 'https://llm.keva.dev/';
const KEVA_CATALOG_TIMEOUT_MS = 5_000;

export interface KevaCatalogModel {
	id: string;
	active: boolean;
	status: string;
}

export interface KevaCatalog {
	defaultModel: string;
	models: KevaCatalogModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the public service document instead of trusting its JSON shape. */
export function parseKevaCatalog(value: unknown): KevaCatalog | null {
	if (!isRecord(value) || !Array.isArray(value.models)) return null;

	const models: KevaCatalogModel[] = [];
	const seen = new Set<string>();
	for (const item of value.models) {
		if (!isRecord(item) || typeof item.id !== 'string') continue;
		const id = item.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			active: item.active === true,
			status: typeof item.status === 'string' ? item.status : 'unknown'
		});
	}
	if (models.length === 0) return null;

	const requestedDefault =
		typeof value.default_model === 'string' ? value.default_model.trim() : '';
	const active = models.find((model) => model.active)?.id;
	const defaultModel =
		(requestedDefault && models.some((model) => model.id === requestedDefault)
			? requestedDefault
			: active) ?? models[0].id;

	return { defaultModel, models };
}

let catalogPromise: Promise<KevaCatalog | null> | null = null;

/** Fetch once per server process. The bundled catalog is the offline fallback. */
export function getKevaCatalog(): Promise<KevaCatalog | null> {
	if (!catalogPromise) {
		catalogPromise = fetch(KEVA_CATALOG_URL, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(KEVA_CATALOG_TIMEOUT_MS)
		})
			.then(async (response) => {
				if (!response.ok) return null;
				return parseKevaCatalog(await response.json());
			})
			.catch(() => null);
	}
	return catalogPromise;
}

interface KevaModelDefinition {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap: (typeof DEFAULT_MODELS_CONFIG.providers.keva.models)[number]['thinkingLevelMap'];
	input: readonly ('text' | 'image')[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

function fallbackDefinition(id: string): KevaModelDefinition {
	const known = DEFAULT_MODELS_CONFIG.providers.keva.models.find((model) => model.id === id);
	if (known) return known;

	return {
		id,
		name: id,
		reasoning: true,
		thinkingLevelMap: DEFAULT_MODELS_CONFIG.providers.keva.models[0].thinkingLevelMap,
		input: ['text'],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0.1, output: 0.3, cacheRead: 0.01, cacheWrite: 0.1 }
	};
}

/** Build the Pi catalog from the service order, retaining local capability metadata. */
export function kevaModelDefinitions(catalog: KevaCatalog | null): KevaModelDefinition[] {
	if (!catalog) return [...DEFAULT_MODELS_CONFIG.providers.keva.models];
	return catalog.models.map((model) => fallbackDefinition(model.id));
}
