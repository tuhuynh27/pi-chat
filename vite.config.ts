import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	ssr: {
		// Keep the Pi SDK external for the Node server build
		external: ['@earendil-works/pi-coding-agent']
	}
});
