import { json } from '@sveltejs/kit';
import { isSandboxed, listModels } from '$lib/server/pi';

/** Model catalog + environment flags. Per-conversation settings come from /api/conversations/:id. */
export const GET = async () => {
	try {
		const models = await listModels();
		return json({ models, sandboxed: isSandboxed() });
	} catch (err) {
		return json(
			{ models: [], sandboxed: isSandboxed(), error: err instanceof Error ? err.message : String(err) },
			{ status: 500 }
		);
	}
};
