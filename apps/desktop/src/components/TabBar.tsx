import { useStoreValue } from "@simplestack/store/react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { isChangelogPath } from "../lib/changelogNote";
import { basename } from "../lib/filePath";
import { closeTab, switchToTab } from "../store/actions";
import { currentPathStore } from "../store/state";
import { tabsStore } from "../store/tabs";

function tabLabel(path: string | null | undefined) {
	if (!path) return "Untitled";
	if (isChangelogPath(path)) return "What's new";
	return basename(path);
}

/**
 * One row of open notes. Hidden while a single note is open so the
 * single-document layout stays unchanged.
 */
export function TabBar() {
	const { tabs, activeTabId } = useStoreValue(tabsStore);
	const activePath = useStoreValue(currentPathStore);
	if (tabs.length < 2) return null;

	return (
		<div
			role="tablist"
			aria-label="Open notes"
			className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-background"
		>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				const path = isActive ? activePath : (tab.buffer?.currentPath ?? null);
				const label = tabLabel(path);
				return (
					<div
						key={tab.id}
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
						className={`group flex min-w-24 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-e border-border px-2.5 text-[11px] outline-hidden select-none ${
							isActive
								? "bg-card text-foreground"
								: "text-muted-foreground hover:bg-accent/50"
						}`}
					>
						<span className="min-w-0 flex-1 truncate">{label}</span>
						<button
							type="button"
							aria-label={`Close ${label}`}
							title={`Close ${label}`}
							className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
							onClick={(event) => {
								event.stopPropagation();
								void closeTab(tab.id);
							}}
						>
							<MingcuteCloseLine className="size-3" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
