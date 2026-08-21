const listeners = new Set<() => void>();

let observer: MutationObserver | undefined;
let lastValue = false;

export function isDarkMode(): boolean {
	if (typeof document === "undefined") return false;
	return document.documentElement.classList.contains("dark");
}

export function subscribeDarkMode(listener: () => void): () => void {
	listeners.add(listener);
	if (!observer && typeof MutationObserver !== "undefined") {
		lastValue = isDarkMode();
		observer = new MutationObserver(() => {
			const next = isDarkMode();
			if (next === lastValue) return;
			lastValue = next;
			for (const notify of listeners) notify();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			observer?.disconnect();
			observer = undefined;
		}
	};
}
