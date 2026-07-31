import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const statusSource = await readFile(new URL("../web/src/issueBoardStatuses.ts", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../web/src/components/OtherTasksPanel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

function statusList(name) {
  const match = statusSource.match(new RegExp(`export const ${name} = \\[(.*?)\\] as const`, "s"));
  assert.ok(match, `${name} should be declared as a readonly status list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function cssBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = styles.indexOf("\n}", start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 2);
}

test("the issue workspace projects the seven statuses into fixed main and secondary groups", () => {
  assert.deepEqual(statusList("MAIN_STATUSES"), ["todo", "in_progress", "in_review"]);
  assert.deepEqual(statusList("SECONDARY_STATUSES"), ["backlog", "blocked", "done", "canceled"]);
  assert.match(statusSource, /satisfies readonly TaskStatus\[\]/);
  assert.match(appSource, /MAIN_STATUSES\.map\(\(status\) => \([\s\S]*?<BoardColumn/);
  assert.match(appSource, /MAIN_STATUSES\.map\(\(status\) => \([\s\S]*?className="loading-column"/);
  assert.match(boardColumnSource, /todo: \{ label: "待处理", tone: "todo" \}/);
  assert.match(boardColumnSource, /in_progress: \{ label: "处理中", tone: "progress" \}/);
  assert.match(boardColumnSource, /in_review: \{ label: "等你确认", tone: "review" \}/);
});

test("other tasks is a closed-by-default non-modal dock with four counted tabs", () => {
  assert.match(appSource, /useState\(false\)/);
  assert.match(appSource, /useState<SecondaryTaskStatus>\("backlog"\)/);
  assert.match(appSource, /className=\{`other-tasks-trigger\$\{otherTasksOpen \? " is-open" : ""\}`\}/);
  assert.match(appSource, /aria-controls="other-tasks-panel"/);
  assert.match(appSource, /aria-expanded=\{otherTasksOpen\}/);
  assert.match(appSource, /otherTasksOpen && \([\s\S]*?<OtherTasksPanel/);
  assert.match(panelSource, /<aside[\s\S]*?id="other-tasks-panel"/);
  assert.match(panelSource, /<h2 id="other-tasks-heading">其他任务<\/h2>/);
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /SECONDARY_STATUSES\.map\(\(status\) =>/);
  assert.match(panelSource, /aria-selected=\{selected\}/);
  assert.match(panelSource, /tasksByStatus\[status\]\.length/);
  assert.match(panelSource, /aria-label="关闭其他任务"/);
  assert.doesNotMatch(panelSource, /createPortal|role="dialog"|backdrop|overlay/);
  assert.match(cssBlock(".issue-board-layout"), /display: flex/);
  assert.match(cssBlock(".other-tasks-panel"), /flex: 0 0 clamp\(280px, 30vw, 360px\)/);
  assert.doesNotMatch(cssBlock(".other-tasks-panel"), /position:\s*(?:fixed|absolute)/);
});

test("search and filters feed the same status buckets used by the board and panel", () => {
  assert.match(appSource, /const filteredTasks = useMemo\([\s\S]*?matchesTaskSearch\(task, search\) && matchesTaskFilters\(task, filters\)/);
  assert.match(appSource, /TASK_STATUSES\.map\(\(status\) => \[status, filteredTasks\.filter\(\(task\) => task\.status === status\)\]\)/);
  assert.match(appSource, /tasks=\{tasksByStatus\[status\]\}/);
  assert.match(appSource, /tasksByStatus=\{tasksByStatus\}/);
  assert.match(appSource, /hasActiveFilters=\{hasActiveTaskFilters\}/);
  assert.match(panelSource, /const tasks = tasksByStatus\[activeStatus\]/);
  assert.match(panelSource, /hasActiveFilters \? "当前筛选下无匹配议题"/);
  assert.match(boardColumnSource, /tasks\.length === 0 && <div className="column-empty">\{emptyMessage\}<\/div>/);
});

test("panel cards reuse TaskCard and the existing ranked board drop path", () => {
  assert.match(panelSource, /<TaskCard/);
  assert.match(panelSource, /statusIndex=\{TASK_STATUSES\.indexOf\(task\.status\)\}/);
  assert.match(panelSource, /onEdit=\{onEdit\}/);
  assert.match(panelSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(panelSource, /onMove=\{onMove\}/);
  assert.match(panelSource, /onDragStart=\{onDragStart\}/);
  assert.match(panelSource, /onDragEnd=\{onDragEnd\}/);
  assert.match(panelSource, /onOpenThread=\{onOpenThread\}/);
  assert.equal(appSource.match(/onDragStart=\{startTaskDrag\}/g)?.length, 2);
  assert.equal(appSource.match(/onDragEnd=\{endTaskDrag\}/g)?.length, 2);
  assert.match(boardColumnSource, /findDropBefore\(event\.currentTarget, event\.clientY\)/);
  assert.match(boardColumnSource, /onDrop\(status, taskId, findDropBefore/);
  assert.match(appSource, /onDrop=\{finishTaskDrop\}/);
  assert.match(appSource, /moveTask\(task, destination, beforeTaskId, true\)/);
});

test("global creation defaults to todo while per-column creation keeps the chosen status", () => {
  assert.equal(appSource.match(/setEditor\(\{ task: null, status: "todo" \}\)/g)?.length, 2);
  assert.doesNotMatch(appSource, /setEditor\(\{ task: null, status: "backlog" \}\)/);
  assert.match(appSource, /onCreate=\{\(initialStatus\) => setEditor\(\{ task: null, status: initialStatus \}\)\}/);
});

test("legacy empty-column and manual visibility runtime paths are removed", async () => {
  assert.doesNotMatch(appSource, /showEmptyColumns|visibleStatuses|hiddenStatuses|columnVisibility|SHOW_EMPTY_COLUMNS_KEY|COLUMN_VISIBILITY_KEY/);
  assert.doesNotMatch(boardColumnSource, /ColumnVisibilityMenu|onHide|隐藏列/);
  assert.doesNotMatch(styles, /\.hidden-columns|\.hidden-column-|\.column-visibility-|\.column-menu|\.board-settings-trigger|\.board-settings-menu|\.board-filter-empty/);
  assert.match(styles, /\.board-setting-switch \{/);

  await assert.rejects(access(new URL("../web/src/components/HiddenColumns.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../web/src/components/BoardSettingsMenu.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../web/src/components/ColumnVisibilityMenu.tsx", import.meta.url)));
});

test("the three-column desktop grid fills available width and degrades to horizontal scrolling", () => {
  assert.match(cssBlock(".board"), /display: grid/);
  assert.match(cssBlock(".board"), /grid-template-columns: repeat\(3, minmax\(260px, 1fr\)\)/);
  assert.match(cssBlock(".board"), /width: 100%/);
  assert.match(cssBlock(".board-scroll"), /overflow-x: auto/);
  assert.match(cssBlock(".board-scroll"), /overflow-y: hidden/);
  assert.match(cssBlock(".board-column"), /overflow-y: auto/);
  assert.match(cssBlock(".column-header"), /position: sticky/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?grid-template-columns: repeat\(3, min\(84vw, 300px\)\)/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.other-tasks-panel \{[\s\S]*?flex-basis: min\(70vw, 280px\)/);
});
