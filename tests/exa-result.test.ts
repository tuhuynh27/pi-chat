import assert from 'node:assert/strict';
import test from 'node:test';
import {
	EXA_LIMITS,
	fetchCharactersPerUrl,
	fetchResult,
	searchResult
} from '../src/lib/server/exa-result.ts';

function outputResults(result: ReturnType<typeof searchResult> | ReturnType<typeof fetchResult>) {
	return JSON.parse(result.content[0].text).results as Record<string, unknown>[];
}

test('caps search results and highlight context', () => {
	const result = searchResult({
		results: Array.from({ length: 8 }, (_, index) => ({
			title: `Result ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			highlights: ['x'.repeat(2_000), 'unused highlight']
		}))
	});
	const items = outputResults(result);

	assert.equal(items.length, EXA_LIMITS.searchResults);
	assert.equal((items[0].highlights as string[]).length, 1);
	assert.equal((items[0].highlights as string[])[0].length, EXA_LIMITS.searchHighlightCharacters);
});

test('allocates fetch limits within the total context budget', () => {
	assert.equal(fetchCharactersPerUrl(1), 8_000);
	assert.equal(fetchCharactersPerUrl(2), 8_000);
	assert.equal(fetchCharactersPerUrl(3), 8_000);
	assert.equal(fetchCharactersPerUrl(3, 100), 1_000);
	assert.equal(fetchCharactersPerUrl(2, 12_000), 12_000);
	assert.equal(fetchCharactersPerUrl(3, 12_000), 8_000);
});

test('locally caps fetched text even when Exa returns oversized content', () => {
	const result = fetchResult(
		{
			results: Array.from({ length: 5 }, (_, index) => ({
				title: `Page ${index + 1}`,
				url: `https://example.com/${index + 1}`,
				text: 'x'.repeat(20_000)
			})),
			statuses: Array.from({ length: 5 }, (_, index) => ({
				id: `https://example.com/${index + 1}`,
				status: 'success'
			}))
		},
		12_000
	);
	const items = outputResults(result);
	const totalTextCharacters = items.reduce((total, item) => total + String(item.text).length, 0);

	assert.equal(items.length, EXA_LIMITS.fetchUrls);
	assert.ok(totalTextCharacters <= EXA_LIMITS.maxFetchTotalCharacters);
	assert.ok(items.every((item) => item.truncated === true));
	assert.ok(items.every((item) => item.status === 'success'));
});
