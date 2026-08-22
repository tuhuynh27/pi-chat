<script lang="ts">
	import { MAX_IMAGES, type ImageAttachment } from '$lib/types';

	interface Pending {
		id: string;
		dataUrl: string;
		mimeType: string;
		loading: boolean;
	}

	let {
		busy,
		disabled = false,
		onSend,
		onStop,
		text = $bindable(''),
		stats = null
	}: {
		busy: boolean;
		disabled?: boolean;
		onSend: (text: string, images: ImageAttachment[]) => void;
		onStop: () => void;
		text?: string;
		/** Token/s + context telemetry for the footer line (null when there is nothing to show). */
		stats?: { speed: string | null; context: string | null } | null;
	} = $props();

	let el: HTMLTextAreaElement;
	let fileInput: HTMLInputElement;
	let attachments = $state<Pending[]>([]);
	let dragOver = $state(false);
	let notice = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;

	const uid = () =>
		typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

	function autoresize() {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	function flash(message: string) {
		notice = message;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 2400);
	}

	/** Downscale to a sane max dimension and re-encode; keeps pasted screenshots small. */
	const MAX_DIM = 1568;
	async function process(file: File): Promise<{ dataUrl: string; mimeType: string } | null> {
		if (!file.type.startsWith('image/')) return null;
		const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
		if (!bitmap) return null;
		const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		bitmap.close();
		const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
		const dataUrl = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.85 : undefined);
		return { dataUrl, mimeType };
	}

	async function addFiles(files: Iterable<File>) {
		if (disabled) return;
		const incoming = [...files].filter((f) => f.type.startsWith('image/'));
		if (!incoming.length) return;
		const room = MAX_IMAGES - attachments.length;
		if (room <= 0) {
			flash(`Up to ${MAX_IMAGES} images per message.`);
			return;
		}
		const accepted = incoming.slice(0, room);
		if (incoming.length > accepted.length) flash(`Up to ${MAX_IMAGES} images per message.`);

		const placeholders = accepted.map(() => ({ id: uid(), dataUrl: '', mimeType: '', loading: true }));
		attachments = [...attachments, ...placeholders];

		await Promise.all(
			accepted.map(async (file, i) => {
				const result = await process(file);
				const placeholder = placeholders[i];
				if (!result) {
					attachments = attachments.filter((a) => a.id !== placeholder.id);
					flash('Could not read that image.');
					return;
				}
				attachments = attachments.map((a) =>
					a.id === placeholder.id ? { ...a, dataUrl: result.dataUrl, mimeType: result.mimeType, loading: false } : a
				);
			})
		);
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	function onPaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files = [...items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
		const images = files.filter((f): f is File => f !== null);
		if (!images.length) return;
		e.preventDefault();
		void addFiles(images);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (!disabled && e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
	}

	function submit() {
		const t = text.trim();
		const ready = attachments.filter((a) => !a.loading);
		if ((!t && ready.length === 0) || busy || disabled || attachments.some((a) => a.loading)) return;
		const images: ImageAttachment[] = ready.map((a) => ({
			mimeType: a.mimeType,
			data: a.dataUrl.slice(a.dataUrl.indexOf(',') + 1)
		}));
		text = '';
		attachments = [];
		if (window.matchMedia('(max-width: 719px)').matches) el.blur();
		requestAnimationFrame(autoresize);
		onSend(t, images);
	}
</script>

<div class="composer-wrap">
	<form
		class="composer"
		class:drag={dragOver}
		class:disabled
		ondragover={(e) => {
			e.preventDefault();
			if (!disabled) dragOver = true;
		}}
		ondragleave={() => (dragOver = false)}
		ondrop={onDrop}
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		{#if attachments.length > 0}
			<div class="attachments">
				{#each attachments as a (a.id)}
					<div class="thumb" class:loading={a.loading}>
						{#if a.dataUrl}
							<img src={a.dataUrl} alt="" />
						{/if}
						<button type="button" class="thumb-remove" onclick={() => removeAttachment(a.id)} aria-label="Remove image">
							<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
								<path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.3" />
							</svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="composer-row">
			<input
				bind:this={fileInput}
				type="file"
				accept="image/*"
				multiple
				disabled={disabled}
				class="file-input"
				onchange={(e) => {
					const files = (e.currentTarget as HTMLInputElement).files;
					if (files) void addFiles(files);
					(e.currentTarget as HTMLInputElement).value = '';
				}}
			/>
			<button
				type="button"
				class="attach"
				disabled={disabled || attachments.length >= MAX_IMAGES}
				onclick={() => fileInput.click()}
				aria-label="Attach images"
			>
				<svg width="16" height="16" viewBox="0.54 0.38 16 16" aria-hidden="true">
					<path
						d="M10.8 4.2 5.6 9.4a2 2 0 0 0 2.8 2.8l5-5a3.3 3.3 0 0 0-4.7-4.7l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.6-4.6"
						stroke="currentColor"
						stroke-width="1.3"
						fill="none"
						stroke-linecap="round"
					/>
				</svg>
			</button>
			<textarea
				bind:this={el}
				bind:value={text}
				rows="1"
				placeholder="Message pi…"
				autocapitalize="off"
				autocomplete="off"
				disabled={disabled}
				oninput={autoresize}
				onpaste={onPaste}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
			></textarea>
			{#if busy}
				<button type="button" class="send stop" onclick={onStop} aria-label="Stop">
					<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
						<rect x="1" y="1" width="9" height="9" fill="currentColor" />
					</svg>
				</button>
			{:else}
				<button
					type="submit"
					class="send"
					disabled={disabled || (!text.trim() && attachments.length === 0) || attachments.some((a) => a.loading)}
					aria-label="Send"
				>
					<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
						<path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" stroke="currentColor" stroke-width="1.6" fill="none" />
					</svg>
				</button>
			{/if}
		</div>
	</form>
	<div class="composer-meta" class:has-stats={!!stats}>
		<p class="hint">{notice || 'shift+enter for a new line'}</p>
		{#if stats}
			<p class="stats" aria-hidden="true">
				{#if stats.speed}<span class="stat-speed">{stats.speed}</span>{/if}
				{#if stats.speed && stats.context}<span class="stat-sep">·</span>{/if}
				{#if stats.context}<span>{stats.context}</span>{/if}
			</p>
		{/if}
	</div>
</div>
