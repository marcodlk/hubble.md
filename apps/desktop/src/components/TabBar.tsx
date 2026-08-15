import { useStoreValue } from "@simplestack/store/react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { isChangelogPath } from "../lib/changelogNote";
import { basename, dirname, duplicateBasenames } from "../lib/filePath";
import { closeTab, switchToTab } from "../store/actions";
import { currentPathStore, viewerStore } from "../store/state";
import { documentIndicator, type TabIndicator, tabsStore } from "../store/tabs";

function tabLabel(path: string | null | undefined) {
	if (!path) return "Untitled";
	if (isChangelogPath(path)) return "What's new";
	return basename(path);
}

/**
 * The dot a tab shows instead of its close button until the pointer is over it,
 * the way editors mark an unsaved buffer. A conflict keeps its own colour: the
 * note needs a decision, not just a save.
 */
function TabIndicatorDot({ indicator }: { indicator: TabIndicator }) {
	if (indicator === "none") return null;
	const conflict = indicator === "conflict";
	const description = conflict ? "File changed on disk" : "Unsaved changes";
	return (
		<span
			role="img"
			aria-label={description}
			title={description}
			className="pointer-events-none absolute inset-0 flex items-center justify-center group-hover:opacity-0 group-focus-within/close:opacity-0"
		>
			<span
				className={`size-2 rounded-full ${conflict ? "bg-destructive" : "bg-current"}`}
			/>
		</span>
	);
}

/**
 * Keeps the active tab on screen. A keyboard switch can land on a tab the row
 * has scrolled past, which would otherwise leave the bar showing no selection
 * at all. React runs this when a tab becomes the active one, not on every
 * render, so the row does not fight a scroll the user is making by hand.
 */
function revealActiveTab(element: HTMLDivElement | null) {
	element?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * One row of open notes. Hidden while a single note is open so the
 * single-document layout stays unchanged.
 */
export function TabBar() {
	const { tabs, activeTabId } = useStoreValue(tabsStore);
	const activePath = useStoreValue(currentPathStore);
	// Background buffers live in `tabsStore`, so they already re-render this
	// component. The active document does not: it needs its own subscription,
	// narrowed to the badge so typing only re-renders when the badge flips.
	const activeIndicator = useStoreValue(viewerStore, documentIndicator);
	if (tabs.length < 2) return null;

	const paths = tabs.map((tab) =>
		tab.id === activeTabId ? activePath : (tab.buffer?.currentPath ?? null),
	);
	// Two notes named the same are told apart by their folder, as in the
	// workspace switcher.
	const duplicateNames = duplicateBasenames(
		paths.filter((path): path is string => path !== null),
	);

	return (
		<div
			role="tablist"
			aria-label="Open notes"
			className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-background"
		>
			{tabs.map((tab, index) => {
				const isActive = tab.id === activeTabId;
				const path = paths[index];
				const label = tabLabel(path);
				// A note at the filesystem root has no folder name to fall back on,
				// so it keeps the bare file name.
				const folder =
					path && !isChangelogPath(path) && duplicateNames.has(label)
						? basename(dirname(path) ?? "")
						: "";
				const indicator = isActive
					? activeIndicator
					: documentIndicator(tab.buffer);
				return (
					<div
						key={tab.id}
						ref={isActive ? revealActiveTab : null}
						role="tab"
						aria-selected={isActive}
						tabIndex={isActive ? 0 : -1}
						title={path ?? label}
						onClick={() => void switchToTab(tab.id)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							void switchToTab(tab.id);
						}}
						// Middle-click closes the tab; the matching mousedown is swallowed
						// so Chromium does not start autoscrolling instead.
						onMouseDown={(event) => {
							if (event.button === 1) event.preventDefault();
						}}
						onAuxClick={(event) => {
							if (event.button !== 1) return;
							event.preventDefault();
							void closeTab(tab.id);
						}}
						className={`group flex min-w-24 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-e border-border px-2.5 text-[11px] outline-hidden select-none ${
							isActive
								? "bg-card text-foreground"
								: "text-muted-foreground hover:bg-accent/50"
						}`}
					>
						<span className="min-w-0 flex-1 truncate">
							{label}
							{folder ? (
								<span className="text-muted-foreground/70"> · {folder}</span>
							) : null}
						</span>
						{/* Dot and close button share one slot: the dot gives way on
						    hover, and to the close button taking focus. */}
						<span className="group/close relative flex size-4 shrink-0 items-center justify-center">
							<TabIndicatorDot indicator={indicator} />
							<button
								type="button"
								aria-label={`Close ${label}`}
								title={`Close ${label}`}
								className="absolute inset-0 flex items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								onClick={(event) => {
									event.stopPropagation();
									void closeTab(tab.id);
								}}
							>
								<MingcuteCloseLine className="size-3" />
							</button>
						</span>
					</div>
				);
			})}
		</div>
	);
}
