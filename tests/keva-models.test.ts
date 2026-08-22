import assert from 'node:assert/strict';
import test from 'node:test';
import { kevaModelDefinitions, parseKevaCatalog } from '../src/lib/server/keva-models.ts';

test('parses the public Keva model catalog and preserves its order', () => {
	const catalog = parseKevaCatalog({
		default_model: 'qwen3.8-27b',
		models: [
			{ id: 'qwen3.6-35b-a3b', active: false, status: 'unknown' },
			{ id: 'qwen3.8-27b', active: true, status: 'running' }
		]
	});

	assert.deepEqual(catalog, {
		defaultModel: 'qwen3.8-27b',
		models: [
			{ id: 'qwen3.6-35b-a3b', active: false, status: 'unknown' },
			{ id: 'qwen3.8-27b', active: true, status: 'running' }
		]
	});
	assert.deepEqual(
		kevaModelDefinitions(catalog).map((model) => model.id),
		['qwen3.6-35b-a3b', 'qwen3.8-27b']
	);
});

test('uses the active model when the advertised default is invalid', () => {
	const catalog = parseKevaCatalog({
		default_model: 'missing',
		models: [{ id: 'qwen3.8-27b', active: true, status: 'running' }]
	});

	assert.equal(catalog?.defaultModel, 'qwen3.8-27b');
});

test('rejects an empty or malformed model catalog', () => {
	assert.equal(parseKevaCatalog(null), null);
	assert.equal(parseKevaCatalog({ models: [] }), null);
	assert.equal(parseKevaCatalog({ models: [{ status: 'running' }] }), null);
});
