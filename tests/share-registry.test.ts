import assert from 'node:assert/strict';
import test from 'node:test';
import { ShareRegistry } from '../src/lib/server/share-registry.ts';

test('reuses one share token for a conversation', () => {
	const registry = new ShareRegistry();
	let sequence = 0;
	const createToken = () => `token-${++sequence}`;

	assert.deepEqual(registry.getOrCreate('conversation-1', createToken), {
		token: 'token-1',
		created: true
	});
	assert.deepEqual(registry.getOrCreate('conversation-1', createToken), {
		token: 'token-1',
		created: false
	});
	assert.equal(sequence, 1);
});

test('restores share pointers and removes them with their conversation', () => {
	const original = new ShareRegistry();
	original.getOrCreate('conversation-1', () => 'durable-token');

	const restored = new ShareRegistry();
	restored.load(original.toJSON(), (id) => id === 'conversation-1');
	assert.equal(restored.conversationIdFor('durable-token'), 'conversation-1');
	assert.deepEqual(restored.getOrCreate('conversation-1', () => 'unused-token'), {
		token: 'durable-token',
		created: false
	});

	assert.equal(restored.deleteConversation('conversation-1'), true);
	assert.equal(restored.conversationIdFor('durable-token'), null);
});

test('ignores invalid, orphaned, and duplicate persisted pointers', () => {
	const registry = new ShareRegistry();
	registry.load(
		[
			{ conversationId: 'missing', token: 'orphaned' },
			{ conversationId: 'conversation-1', token: 'kept' },
			{ conversationId: 'conversation-1', token: 'duplicate-conversation' },
			{ conversationId: 'conversation-2', token: 'kept' },
			{ conversationId: 3, token: 'invalid' }
		],
		(id) => id === 'conversation-1' || id === 'conversation-2'
	);

	assert.equal(registry.conversationIdFor('kept'), 'conversation-1');
	assert.equal(registry.conversationIdFor('orphaned'), null);
	assert.equal(registry.conversationIdFor('duplicate-conversation'), null);
	assert.equal(registry.getOrCreate('conversation-2', () => 'new-token').token, 'new-token');
});
