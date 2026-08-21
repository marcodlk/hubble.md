// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDarkMode, subscribeDarkMode } from "./darkMode";

const unsubscribes: Array<() => void> = [];

function subscribe(listener: () => void) {
	const unsubscribe = subscribeDarkMode(listener);
	unsubscribes.push(unsubscribe);
	return unsubscribe;
}

async function flushMutations() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	document.documentElement.className = "";
});

afterEach(() => {
	for (const unsubscribe of unsubscribes) unsubscribe();
	unsubscribes.length = 0;
	document.documentElement.className = "";
});

describe("dark mode observable", () => {
	it("reads the dark class off the document element", () => {
		expect(isDarkMode()).toBe(false);
		document.documentElement.classList.add("dark");
		expect(isDarkMode()).toBe(true);
	});

	it("notifies subscribers when the dark class toggles", async () => {
		const listener = vi.fn();
		subscribe(listener);

		document.documentElement.classList.add("dark");
		await flushMutations();
		expect(listener).toHaveBeenCalledTimes(1);

		document.documentElement.classList.remove("dark");
		await flushMutations();
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("ignores class changes that do not flip the dark flag", async () => {
		const listener = vi.fn();
		subscribe(listener);

		document.documentElement.classList.add("something-else");
		await flushMutations();

		expect(listener).not.toHaveBeenCalled();
	});

	it("stops notifying after unsubscribe", async () => {
		const listener = vi.fn();
		const unsubscribe = subscribe(listener);

		unsubscribe();
		document.documentElement.classList.add("dark");
		await flushMutations();

		expect(listener).not.toHaveBeenCalled();
	});
});
