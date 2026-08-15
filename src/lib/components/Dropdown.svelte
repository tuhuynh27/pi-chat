<script lang="ts">
	/**
	 * Minimal listbox dropdown (replaces native <select>).
	 * Mouse + touch (pointer events), keyboard: Enter/Space open,
	 * ArrowUp/Down move, Enter selects, Escape closes. Closes on outside tap.
	 */
	let {
		label,
		value,
		options,
		disabled = false,
		onChange
	}: {
		label: string;
		value: string;
		options: { value: string; label: string }[];
		disabled?: boolean;
		onChange: (value: string) => void;
	} = $props();

	let open = $state(false);
	let activeIdx = $state(0);
	let root = $state<HTMLDivElement | undefined>(undefined);
	let menu = $state<HTMLDivElement | undefined>(undefined);

	const currentIdx = $derived(options.findIndex((o) => o.value === value));
	const current = $derived(currentIdx >= 0 ? options[currentIdx] : undefined);

	function setOpen(next: boolean) {
		open = next;
		if (next) activeIdx = currentIdx >= 0 ? currentIdx : 0;
	}

	function select(idx: number) {
		const o = options[idx];
		setOpen(false);
		if (o && o.value !== value) onChange(o.value);
	}

	function move(delta: number) {
		if (options.length === 0) return;
		activeIdx = (activeIdx + delta + options.length) % options.length;
	}

	function onKey(e: KeyboardEvent) {
		if (disabled) return;
		if (!open) {
			if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				setOpen(true);
			}
			return;
		}
		switch (e.key) {
			case 'Enter':
			case ' ':
				e.preventDefault();
				select(activeIdx);
				break;
			case 'ArrowDown':
				e.preventDefault();
				move(1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				move(-1);
				break;
			case 'Escape':
				setOpen(false);
				break;
		}
	}

	// Close when pressing/tapping anywhere outside.
	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});

	// Keep the keyboard-highlighted option visible.
	$effect(() => {
		void open;
		void activeIdx;
		if (open && menu) {
			(menu.children[activeIdx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
		}
	});
</script>

<div class="dd" class:open bind:this={root}>
	<button
		type="button"
		class="dd-trigger"
		disabled={disabled}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={label}
		onclick={() => setOpen(!open)}
		onkeydown={onKey}
	>
		<span class="dd-label">{current?.label ?? label}</span>
		<svg class="chev" width="9" height="6" viewBox="0 0 10 6" aria-hidden="true">
			<path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" />
		</svg>
	</button>

	{#if open}
		<div class="dd-menu" role="listbox" aria-label={label} bind:this={menu}>
			{#each options as o, i (o.value)}
				<button
					type="button"
					class="dd-item"
					class:active={i === activeIdx}
					role="option"
					aria-selected={o.value === value}
					onclick={() => select(i)}
					onpointerenter={() => (activeIdx = i)}
				>
					<span class="tick" aria-hidden="true">
						<svg width="11" height="9" viewBox="0 0 11 9">
							<path d="M1 4.5l3 3L10 1" stroke="currentColor" stroke-width="1.5" fill="none" />
						</svg>
					</span>
					<span class="dd-item-label">{o.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
