export interface StoredShare {
	conversationId: string;
	token: string;
}

/** One durable share token per conversation, with fast lookups in both directions. */
export class ShareRegistry {
	private readonly tokenByConversation = new Map<string, string>();
	private readonly conversationByToken = new Map<string, string>();

	load(shares: unknown, conversationExists: (id: string) => boolean): void {
		if (!Array.isArray(shares)) return;
		for (const share of shares) {
			if (
				typeof share !== 'object' ||
				share === null ||
				typeof (share as Partial<StoredShare>).conversationId !== 'string' ||
				typeof (share as Partial<StoredShare>).token !== 'string'
			) {
				continue;
			}
			const { conversationId, token } = share as StoredShare;
			if (!conversationId || !token || !conversationExists(conversationId)) continue;
			if (this.tokenByConversation.has(conversationId) || this.conversationByToken.has(token)) continue;
			this.tokenByConversation.set(conversationId, token);
			this.conversationByToken.set(token, conversationId);
		}
	}

	getOrCreate(conversationId: string, createToken: () => string): { token: string; created: boolean } {
		const existing = this.tokenByConversation.get(conversationId);
		if (existing) return { token: existing, created: false };

		let token = createToken();
		while (!token || this.conversationByToken.has(token)) token = createToken();
		this.tokenByConversation.set(conversationId, token);
		this.conversationByToken.set(token, conversationId);
		return { token, created: true };
	}

	conversationIdFor(token: string): string | null {
		return this.conversationByToken.get(token) ?? null;
	}

	deleteConversation(conversationId: string): boolean {
		const token = this.tokenByConversation.get(conversationId);
		if (!token) return false;
		this.tokenByConversation.delete(conversationId);
		this.conversationByToken.delete(token);
		return true;
	}

	clear(): void {
		this.tokenByConversation.clear();
		this.conversationByToken.clear();
	}

	toJSON(): StoredShare[] {
		return [...this.tokenByConversation].map(([conversationId, token]) => ({
			conversationId,
			token
		}));
	}
}
