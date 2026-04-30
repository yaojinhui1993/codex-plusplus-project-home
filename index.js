/**
 * Project Home
 *
 * Adds a hover-only home icon to sidebar project rows. Opening a project home
 * renders a lightweight in-process view, so it appears immediately.
 */

const STYLE_ID = "codexpp-project-home-style";
const BUTTON_ATTR = "data-codexpp-project-home-button";
const WRAPPER_ATTR = "data-codexpp-project-home-wrapper";
const ACTIVE_ATTR = "data-codexpp-project-home-active";
const VIEW_ATTR = "data-codexpp-project-home-view";
const HASH_PATH_KEY = "codexpp-project-home";
const HASH_LABEL_KEY = "codexpp-project-label";
const ROUTE_EVENT = "codexpp-project-home-route";
const HISTORY_PATCH_KEY = "__codexppProjectHomeHistoryPatch";
const CONTEXT_MENU_ATTR = "data-codexpp-project-home-menu";
const ISSUE_CARD_ATTR = "data-codexpp-project-home-issue-card";
const COLUMN_ATTR = "data-codexpp-project-home-column";
const HEADER_ATTR = "data-codexpp-project-home-header";
const VIEW_MODE_STORAGE_KEY = "project-home:view-mode";
const VISIBLE_COLUMNS_STORAGE_KEY = "project-home:visible-columns";
const COLLAPSED_SECTIONS_STORAGE_KEY = "project-home:collapsed-sections";

const IPC_BOARD_LIST = "project-home:issues:list";
const IPC_ISSUE_CREATE = "project-home:issue:create";
const IPC_ISSUE_UPDATE = "project-home:issue:update";
const IPC_ISSUE_MOVE = "project-home:issue:move";
const IPC_ISSUE_DELETE = "project-home:issue:delete";
const IPC_OPEN_PROJECT_FOLDER = "project-home:project:open-folder";

const ISSUE_COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "In Progress" },
  { id: "in_review", title: "In Review" },
  { id: "done", title: "Done" },
];

const ISSUE_PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const DEFAULT_LABELS = ["bug", "feature", "ui", "docs", "chore"];

const ASIDE_SELECTOR = "aside.pointer-events-auto.relative.flex.overflow-hidden";
const PATH_LIKE_RE = /^(?:~|\/|[A-Za-z]:[\\/])[^\n\r\t]+$/;
const EXCLUDED_LABELS = new Set([
  "account",
  "automations",
  "get plus",
  "help",
  "new chat",
  "add new project",
  "collapse all",
  "filter sidebar chats",
  "performance boost",
  "pinned",
  "plugins",
  "projects",
  "rate limits",
  "search",
  "settings",
  "subway surfers",
  "ui improvements",
  "upgrade",
  "upgrade plan",
]);

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    if (api.process === "main") {
      startMain(this, api);
      return;
    }
    startRenderer(this, api);
  },

  stop() {
    const state = this._state;
    if (!state) return;
    if (state.process === "main") {
      state.dispose?.();
      this._state = null;
      return;
    }
    state.disposed = true;
    document.removeEventListener("pointerdown", state.onPointerDown, true);
    document.removeEventListener("click", state.onClick, true);
    document.removeEventListener("keydown", state.onKeyDown, true);
    window.removeEventListener("resize", state.onResize);
    window.removeEventListener("popstate", state.onRouteChange);
    window.removeEventListener("hashchange", state.onRouteChange);
    window.removeEventListener(ROUTE_EVENT, state.onRouteChange);
    state.restoreHistory?.();
    state.observer?.disconnect();
    if (state.applyTimer) window.clearTimeout(state.applyTimer);
    for (const timer of state.retryTimers || []) window.clearTimeout(timer);
    closeProjectHomeContextMenu(state);
    removeProjectHomeView(state);
    clearProjectHomeMarks();
    state.style?.remove();
    this._state = null;
  },
};

function startMain(self, api) {
  const { createIssueStore } = require("./project-home-store");
  const store = createIssueStore();
  const state = {
    process: "main",
    dispose() {
      removeMainHandler(api, IPC_BOARD_LIST);
      removeMainHandler(api, IPC_ISSUE_CREATE);
      removeMainHandler(api, IPC_ISSUE_UPDATE);
      removeMainHandler(api, IPC_ISSUE_MOVE);
      removeMainHandler(api, IPC_ISSUE_DELETE);
      removeMainHandler(api, IPC_OPEN_PROJECT_FOLDER);
    },
  };
  self._state = state;

  replaceMainHandler(api, IPC_BOARD_LIST, (payload) =>
    store.list(requireProjectPath(payload)));
  replaceMainHandler(api, IPC_ISSUE_CREATE, (payload) =>
    store.create(requireProjectPath(payload), payload || {}));
  replaceMainHandler(api, IPC_ISSUE_UPDATE, (payload) =>
    store.update(requireProjectPath(payload), requireIssueId(payload), payload || {}));
  replaceMainHandler(api, IPC_ISSUE_MOVE, (payload) =>
    store.move(
      requireProjectPath(payload),
      requireIssueId(payload),
      String(payload?.status || ""),
      String(payload?.beforeIssueId || ""),
    ));
  replaceMainHandler(api, IPC_ISSUE_DELETE, (payload) =>
    store.delete(requireProjectPath(payload), requireIssueId(payload)));
  replaceMainHandler(api, IPC_OPEN_PROJECT_FOLDER, async (payload) => {
    const { shell } = require("electron");
    const result = await shell.openPath(requireProjectPath(payload));
    return { ok: !result, error: result || "" };
  });

  api.log.info("[project-home] main issue store active", { root: store.root });
}

function replaceMainHandler(api, channel, handler) {
  removeMainHandler(api, channel);
  api.ipc.handle(channel, handler);
}

function removeMainHandler(api, channel) {
  try {
    const { ipcMain } = require("electron");
    ipcMain.removeHandler(`codexpp:${api.manifest.id}:${channel}`);
  } catch {}
}

function requireProjectPath(payload) {
  const path = String(payload?.projectPath || "").trim();
  if (!path) throw new Error("projectPath is required");
  return path;
}

function requireIssueId(payload) {
  const id = String(payload?.issueId || "").trim();
  if (!id) throw new Error("issueId is required");
  return id;
}

function startRenderer(self, api) {
  const state = {
    process: "renderer",
    api,
    disposed: false,
    style: installStyle(),
    observer: null,
    current: null,
    board: null,
    boardLoading: false,
    boardError: "",
    contextMenu: null,
    dragIssueId: "",
    viewMode: readStoredViewMode(api),
    visibleColumns: readStoredVisibleColumns(api),
    collapsedSections: readStoredCollapsedSections(api),
    editor: null,
    view: null,
    host: null,
    preservedRouteNodes: [],
    restoreTarget: null,
    hiddenHeaderNodes: [],
    headerNode: null,
    headerSignature: "",
    renderToken: 0,
    ignoreRouteUntil: 0,
    applyTimer: null,
    retryTimers: [],
    onPointerDown: null,
    onClick: null,
    onKeyDown: null,
    onResize: null,
    onRouteChange: null,
    restoreHistory: null,
  };
  self._state = state;

  state.onPointerDown = (event) => {
    if (!closestHomeButton(event.target)) return;
    stopProjectHomeEvent(event);
  };
  state.onClick = (event) => {
    const button = closestHomeButton(event.target);
    if (!button) {
      const navTarget = externalNavigationTarget(state, event.target);
      if (state.view && navTarget) {
        dismissProjectHomeForNativeNavigation(state, navTarget);
      }
      return;
    }
    stopProjectHomeEvent(event);
    openProjectHomeFromButton(state, button);
  };
  state.onKeyDown = (event) => {
    if (state.view && isNewChatShortcut(event)) {
      const target = findNewChatButton();
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      dismissProjectHomeForNativeNavigation(state, target, { activate: true });
      return;
    }

    if (state.view && isSidebarToggleShortcut(event)) {
      const target = findSidebarToggleButton();
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      state.ignoreRouteUntil = Date.now() + 1200;
      activateNavigationTarget(target);
      window.setTimeout(() => {
        if (!state.current || !state.view || readProjectHomeFromUrl()) return;
        replaceProjectHomeUrl(state.current.path, state.current.label);
      }, 0);
      return;
    }

    if (state.view && isProjectHomeBlockedPanelShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      return;
    }

    if (isProjectHomeShortcut(event)) {
      const project = currentProjectFromSidebar(state);
      if (!project) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      if (state.view && sameProject(state.current, project)) {
        closeProjectHome(state, { updateHistory: true });
        return;
      }
      openProjectHome(state, project.path, project.label);
      return;
    }

    if (event.key === "Escape" && state.view && state.editor) {
      event.preventDefault();
      event.stopPropagation();
      closeIssueEditor(state);
      return;
    }

    // Project Home board shortcuts (only when not typing)
    if (state.view && !state.editor && !isTypingTarget(event.target)) {
      if (isPlainKey(event, "c")) {
        event.preventDefault();
        event.stopPropagation();
        const status = visibleIssueColumns(state)[0]?.id || "backlog";
        openIssueEditor(state, { mode: "create", status });
        return;
      }
      if (isPlainKey(event, "r")) {
        event.preventDefault();
        event.stopPropagation();
        if (state.current) loadProjectHomeBoard(state, state.current, { force: true });
        return;
      }
      if (isPlainKey(event, "v")) {
        event.preventDefault();
        event.stopPropagation();
        state.viewMode = state.viewMode === "list" ? "board" : "list";
        state.api.storage?.set?.(VIEW_MODE_STORAGE_KEY, state.viewMode);
        renderProjectHomeView(state);
        syncHeaderForProjectHome(state);
        return;
      }
      const propertyKey = ({ s: "status", p: "priority", d: "due", a: "assignee", l: "labels" })[event.key?.toLowerCase()];
      if (propertyKey && isPlainKey(event, event.key.toLowerCase())) {
        const hovered = findHoveredIssue(state);
        if (hovered) {
          event.preventDefault();
          event.stopPropagation();
          openIssuePropertySheet(state, hovered.issue, propertyKey, hovered.element);
          return;
        }
      }
      if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const hovered = findHoveredIssue(state);
        if (hovered) {
          event.preventDefault();
          event.stopPropagation();
          confirmDeleteIssue(state, hovered.issue);
          return;
        }
      }
    }

    const button = closestHomeButton(event.target);
    if (!button) return;
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    }
  };
  state.onResize = () => syncProjectHomeHost(state);
  state.onRouteChange = () => handleRouteChange(state);
  state.restoreHistory = patchHistoryNavigation();

  document.addEventListener("pointerdown", state.onPointerDown, true);
  document.addEventListener("click", state.onClick, true);
  document.addEventListener("keydown", state.onKeyDown, true);
  window.addEventListener("resize", state.onResize);
  window.addEventListener("popstate", state.onRouteChange);
  window.addEventListener("hashchange", state.onRouteChange);
  window.addEventListener(ROUTE_EVENT, state.onRouteChange);

  state.observer = new MutationObserver(() => {
    scheduleApply(state);
    syncProjectHomeHost(state);
    if (state.current && state.view && shouldSyncProjectHomeHeader(state)) {
      syncHeaderForProjectHome(state);
    }
  });
  state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  state.retryTimers = [0, 250, 1000, 2500].map((delay) =>
    window.setTimeout(() => scheduleApply(state), delay),
  );
  scheduleApply(state);
  handleRouteChange(state);

  api.log.info("[project-home] renderer active");
}

function installStyle() {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${BUTTON_ATTR}="button"] {
      flex: none;
    }

    body[${ACTIVE_ATTR}="true"] aside [data-app-action-sidebar-thread-active="true"],
    body[${ACTIVE_ATTR}="true"] aside [aria-current="page"] {
      background: transparent !important;
    }

    [${WRAPPER_ATTR}="true"][${ACTIVE_ATTR}="true"],
    :has(> [${WRAPPER_ATTR}="true"][${ACTIVE_ATTR}="true"]) {
      display: flex !important;
      opacity: 1 !important;
    }

    [${BUTTON_ATTR}="button"][${ACTIVE_ATTR}="true"] {
      background: var(--color-token-list-hover-background, var(--color-token-bg-secondary, transparent)) !important;
      color: var(--color-token-foreground, var(--color-token-text-primary, currentColor)) !important;
      opacity: 1 !important;
    }

    [${BUTTON_ATTR}="button"]:hover,
    [${BUTTON_ATTR}="button"]:focus-visible {
      outline: none;
    }

    [${VIEW_ATTR}="root"] {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      background: transparent;
      color: var(--color-token-text-primary, var(--color-foreground, #111));
    }

    [${VIEW_ATTR}="host"] {
      border-top-color: transparent !important;
    }

    [${VIEW_ATTR}="scroll"] {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    [${VIEW_ATTR}="board"] {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(280px, 1fr);
      grid-template-columns: unset;
      gap: 0;
      height: 100%;
      min-height: 0;
      align-items: stretch;
      overflow-x: auto;
      padding: 0;
      background: var(--color-token-main-surface-secondary, var(--color-token-main-surface-primary, Canvas));
    }

    [${COLUMN_ATTR}] {
      min-width: 0;
      min-height: 0;
      border-right: 1px solid var(--color-token-border-light, rgba(127,127,127,.14));
      background: transparent;
    }

    [${COLUMN_ATTR}]:last-child {
      border-right: 0;
    }

    [${COLUMN_ATTR}][data-drop-active="true"] {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.06));
    }

    [${COLUMN_ATTR}] [data-column-header="true"] {
      height: 36px;
      padding: 0 12px;
      border-top: 1px solid var(--color-token-border-light, rgba(127,127,127,.18));
      border-bottom: 1px solid var(--color-token-border-light, rgba(127,127,127,.12));
    }

    [${COLUMN_ATTR}] [data-column-title] {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .01em;
      color: var(--color-token-foreground, currentColor);
    }

    [${COLUMN_ATTR}] [data-column-count] {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .7;
    }

    [${COLUMN_ATTR}] [data-status-dot] {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: none;
      box-shadow: inset 0 0 0 1.5px currentColor;
      background: transparent;
    }
    [${COLUMN_ATTR}][data-status="todo"] [data-status-dot],
    [${VIEW_ATTR}="issue-card"][data-status="todo"] [data-status-dot] { color: #a1a1aa; }
    [${COLUMN_ATTR}][data-status="backlog"] [data-status-dot],
    [${VIEW_ATTR}="issue-card"][data-status="backlog"] [data-status-dot] { color: #71717a; }
    [${COLUMN_ATTR}][data-status="in_progress"] [data-status-dot],
    [${VIEW_ATTR}="issue-card"][data-status="in_progress"] [data-status-dot] {
      color: #f59e0b;
      background: conic-gradient(currentColor 0 50%, transparent 50% 100%);
      box-shadow: inset 0 0 0 1.5px currentColor;
    }
    [${COLUMN_ATTR}][data-status="in_review"] [data-status-dot],
    [${VIEW_ATTR}="issue-card"][data-status="in_review"] [data-status-dot] { color: #10b981; }
    [${COLUMN_ATTR}][data-status="done"] [data-status-dot],
    [${VIEW_ATTR}="issue-card"][data-status="done"] [data-status-dot] {
      color: #6366f1;
      background: currentColor;
    }

    [${VIEW_ATTR}="issue-card"] {
      border: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      border-radius: 8px;
      background: var(--color-token-main-surface-primary, Canvas);
      box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.04);
      cursor: default;
      transition: box-shadow .12s ease, border-color .12s ease, transform .12s ease, background-color .12s ease;
    }

    [${VIEW_ATTR}="issue-card"]:hover {
      border-color: var(--color-token-border, rgba(0,0,0,.28));
      background: var(--color-token-main-surface-tertiary, var(--color-token-main-surface-primary, Canvas));
      box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 6px 14px rgba(0,0,0,.08);
    }

    [${VIEW_ATTR}="issue-card"][data-dragging="true"] {
      cursor: grabbing;
      opacity: .55;
      transform: scale(.99);
    }

    [${VIEW_ATTR}="issue-card"] [data-issue-title] {
      font-size: 13px;
      line-height: 18px;
      font-weight: 500;
      letter-spacing: -0.005em;
    }

    [${VIEW_ATTR}="issue-id"],
    [${VIEW_ATTR}="issue-meta"],
    [${VIEW_ATTR}="issue-description"] {
      overflow-wrap: anywhere;
    }

    [${VIEW_ATTR}="issue-id"] {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace);
      font-size: 11px;
      letter-spacing: .02em;
      text-transform: uppercase;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .75;
    }

    [${VIEW_ATTR}="issue-meta"] [data-pill] {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 20px;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid var(--color-token-border-light, rgba(127,127,127,.18));
      background: transparent;
      font-size: 11px;
      line-height: 1;
      color: var(--color-token-description-foreground, currentColor);
    }

    [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-priority="urgent"] {
      color: #ef4444;
      border-color: rgba(239,68,68,.35);
    }
    [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-priority="high"] {
      color: #f97316;
      border-color: rgba(249,115,22,.35);
    }
    [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-overdue="true"] {
      color: #ef4444;
      border-color: rgba(239,68,68,.35);
    }

    [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-label] {
      color: hsl(var(--label-hue, 220), 60%, 38%);
      border-color: hsl(var(--label-hue, 220), 70%, 60%, .45);
      background: hsl(var(--label-hue, 220), 80%, 60%, .10);
    }
    [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-label] [data-label-dot] {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: hsl(var(--label-hue, 220), 70%, 50%);
      flex: none;
    }
    @media (prefers-color-scheme: dark) {
      [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-label] {
        color: hsl(var(--label-hue, 220), 75%, 78%);
        border-color: hsl(var(--label-hue, 220), 60%, 60%, .35);
        background: hsl(var(--label-hue, 220), 70%, 55%, .14);
      }
      [${VIEW_ATTR}="issue-meta"] [data-pill][data-pill-label] [data-label-dot] {
        background: hsl(var(--label-hue, 220), 75%, 65%);
      }
    }

    [${CONTEXT_MENU_ATTR}="root"] {
      position: fixed;
      z-index: 99999;
      min-width: 220px;
      border: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      border-radius: 8px;
      background: var(--color-token-main-surface-primary, Canvas);
      box-shadow: 0 14px 38px rgba(0, 0, 0, .18);
      padding: 4px;
    }

    [${CONTEXT_MENU_ATTR}="item"] {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--color-token-text-primary, currentColor);
      padding: 7px 8px;
      text-align: left;
      font-size: 13px;
      line-height: 18px;
      cursor: default;
    }

    [${CONTEXT_MENU_ATTR}="item"]:hover,
    [${CONTEXT_MENU_ATTR}="item"]:focus-visible {
      outline: none;
      background: var(--color-token-list-hover-background, rgba(127,127,127,.10));
    }

    [${CONTEXT_MENU_ATTR}="submenu"] {
      position: relative;
    }

    [${CONTEXT_MENU_ATTR}="submenu-panel"] {
      position: absolute;
      left: calc(100% + 4px);
      top: -4px;
      display: none;
      min-width: 190px;
      border: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      border-radius: 8px;
      background: var(--color-token-main-surface-primary, Canvas);
      box-shadow: 0 14px 38px rgba(0, 0, 0, .18);
      padding: 4px;
    }

    [${CONTEXT_MENU_ATTR}="submenu"]:hover [${CONTEXT_MENU_ATTR}="submenu-panel"],
    [${CONTEXT_MENU_ATTR}="submenu"]:focus-within [${CONTEXT_MENU_ATTR}="submenu-panel"] {
      display: block;
    }

    [${CONTEXT_MENU_ATTR}="search"] {
      padding: 4px 4px 6px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--color-token-border-light, var(--color-token-border, rgba(0,0,0,.08)));
    }

    [${CONTEXT_MENU_ATTR}="search-input"] {
      width: 100%;
      border: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 12px;
      line-height: 16px;
      padding: 5px 8px;
      outline: none;
    }

    [${CONTEXT_MENU_ATTR}="search-input"]::placeholder {
      color: var(--color-token-description-foreground, currentColor);
      opacity: .55;
    }

    [${CONTEXT_MENU_ATTR}="search-input"]:focus {
      border-color: var(--color-token-border, rgba(0,0,0,.32));
    }

    [${CONTEXT_MENU_ATTR}="empty"] {
      padding: 8px 10px;
      font-size: 12px;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .7;
    }

    [${VIEW_ATTR}="toolbar-segment"] {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--color-token-border-light, var(--color-token-border, rgba(0,0,0,.12)));
      border-radius: 8px;
      overflow: hidden;
    }

    [${VIEW_ATTR}="toolbar-segment"] button {
      width: 32px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      color: var(--color-token-description-foreground, currentColor);
    }

    [${VIEW_ATTR}="toolbar-segment"] button[aria-pressed="true"] {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.10));
      color: var(--color-token-foreground, currentColor);
    }

    [${VIEW_ATTR}="list"] {
      height: 100%;
      overflow: auto;
      padding: 0;
    }

    [${VIEW_ATTR}="list-row"] {
      display: grid;
      grid-template-columns: 18px 64px minmax(180px, 1fr) 88px 96px 140px;
      gap: 10px;
      align-items: center;
      min-height: 32px;
      padding: 0 14px;
      font-size: 13px;
      line-height: 18px;
      color: var(--color-token-text-primary, currentColor);
      cursor: pointer;
      user-select: none;
      transition: background-color .08s ease;
    }

    [${VIEW_ATTR}="list-row"]:hover {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.06));
    }

    [${VIEW_ATTR}="list-row"]:focus-visible {
      outline: 2px solid var(--color-token-border, rgba(0,0,0,.28));
      outline-offset: -2px;
    }

    [${VIEW_ATTR}="list-row"][data-dragging="true"] {
      opacity: .55;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="status"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="status"] [data-status-dot] {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      box-shadow: inset 0 0 0 1.5px currentColor;
      background: transparent;
    }
    [${VIEW_ATTR}="list-row"][data-status="todo"] [data-status-dot] { color: #a1a1aa; }
    [${VIEW_ATTR}="list-row"][data-status="backlog"] [data-status-dot] { color: #71717a; }
    [${VIEW_ATTR}="list-row"][data-status="in_progress"] [data-status-dot] {
      color: #f59e0b;
      background: conic-gradient(currentColor 0 50%, transparent 50% 100%);
    }
    [${VIEW_ATTR}="list-row"][data-status="in_review"] [data-status-dot] { color: #10b981; }
    [${VIEW_ATTR}="list-row"][data-status="done"] [data-status-dot] {
      color: #6366f1;
      background: currentColor;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="id"] {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace);
      font-size: 11px;
      letter-spacing: .02em;
      text-transform: uppercase;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .65;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="title"] {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 450;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="priority"],
    [${VIEW_ATTR}="list-row"] [data-list-cell="due"],
    [${VIEW_ATTR}="list-row"] [data-list-cell="assignee"] {
      font-size: 12px;
      color: var(--color-token-description-foreground, currentColor);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    [${VIEW_ATTR}="list-row"] [data-list-cell="priority"][data-priority="urgent"] { color: #ef4444; }
    [${VIEW_ATTR}="list-row"] [data-list-cell="priority"][data-priority="high"] { color: #f97316; }
    [${VIEW_ATTR}="list-row"] [data-list-cell="due"][data-overdue="true"] { color: #ef4444; }

    [data-list-section] {
      display: block;
    }

    [data-list-section][data-drop-active="true"] [data-list-section-body] {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.06));
    }

    [data-list-section-header] {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      height: 32px;
      padding: 0 14px;
      border: 0;
      border-top: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      border-bottom: 1px solid var(--color-token-border, rgba(0,0,0,.14));
      background: var(--color-token-main-surface-tertiary, var(--color-token-main-surface-secondary, rgba(127,127,127,.06)));
      position: sticky;
      top: 0;
      z-index: 1;
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
    }

    [data-list-section-header]:hover {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.10));
    }

    [data-list-section-header]:focus-visible {
      outline: 2px solid var(--color-token-border, rgba(0,0,0,.28));
      outline-offset: -2px;
    }

    [data-list-section-caret] {
      display: inline-flex;
      width: 12px;
      height: 12px;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .65;
      transition: transform .12s ease;
    }
    [data-list-section-caret] svg { width: 12px; height: 12px; }

    [data-list-section]:not([data-collapsed="true"]) [data-list-section-caret] {
      transform: rotate(90deg);
    }

    [data-list-section][data-collapsed="true"] [data-list-section-body] {
      display: none;
    }

    [data-list-section] + [data-list-section] [data-list-section-header] {
      margin-top: -1px;
    }

    [data-list-section-header] [data-status-dot] {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      display: inline-block;
      box-shadow: inset 0 0 0 1.5px currentColor;
    }
    [data-list-section][data-status="todo"] [data-list-section-header] [data-status-dot] { color: #a1a1aa; }
    [data-list-section][data-status="backlog"] [data-list-section-header] [data-status-dot] { color: #71717a; }
    [data-list-section][data-status="in_progress"] [data-list-section-header] [data-status-dot] {
      color: #f59e0b;
      background: conic-gradient(currentColor 0 50%, transparent 50% 100%);
    }
    [data-list-section][data-status="in_review"] [data-list-section-header] [data-status-dot] { color: #10b981; }
    [data-list-section][data-status="done"] [data-list-section-header] [data-status-dot] {
      color: #6366f1;
      background: currentColor;
    }

    [data-list-section-title] {
      font-size: 12px;
      font-weight: 600;
      color: var(--color-token-text-primary, currentColor);
      letter-spacing: -.005em;
    }

    [data-list-section-count] {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .75;
      margin-left: 2px;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--color-token-main-surface-primary, rgba(127,127,127,.08));
    }

    [data-list-section-body] {
      min-height: 4px;
    }

    [data-list-empty] {
      padding: 6px 14px 10px;
      font-size: 12px;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .5;
    }

    [${VIEW_ATTR}="editor-backdrop"] {
      position: absolute;
      inset: 0;
      z-index: 30;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 8vh 24px 24px;
      background: rgba(0, 0, 0, .35);
      backdrop-filter: blur(2px);
    }

    [${VIEW_ATTR}="editor-panel"] {
      width: min(640px, 100%);
      max-height: min(82vh, 720px);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--color-token-border, rgba(0,0,0,.18));
      border-radius: 12px;
      background: var(--color-token-main-surface-primary, Canvas);
      box-shadow: 0 24px 60px rgba(0, 0, 0, .28), 0 2px 6px rgba(0, 0, 0, .12);
      overflow: hidden;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-head] {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-token-border-light, rgba(127,127,127,.16));
      font-size: 12px;
      color: var(--color-token-description-foreground, currentColor);
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-head] [data-editor-crumb] {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-body] {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 14px 16px 8px;
      overflow-y: auto;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-title] {
      width: 100%;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--color-token-text-primary, currentColor);
      font: inherit;
      font-size: 18px;
      line-height: 26px;
      font-weight: 600;
      letter-spacing: -.01em;
      padding: 2px 0;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-description] {
      width: 100%;
      min-height: 80px;
      max-height: 280px;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--color-token-text-primary, currentColor);
      font: inherit;
      font-size: 14px;
      line-height: 20px;
      padding: 2px 0;
      resize: none;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-toolbar] {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-token-border-light, rgba(127,127,127,.14));
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-chip] {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 10px;
      border: 1px solid var(--color-token-border-light, rgba(127,127,127,.22));
      border-radius: 6px;
      background: transparent;
      color: var(--color-token-foreground, currentColor);
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-chip]:hover {
      background: var(--color-token-list-hover-background, rgba(127,127,127,.08));
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-chip] select,
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip] input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-chip] [data-status-dot] {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      box-shadow: inset 0 0 0 1.5px currentColor;
    }
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip][data-status="todo"] [data-status-dot] { color: #a1a1aa; }
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip][data-status="backlog"] [data-status-dot] { color: #71717a; }
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip][data-status="in_progress"] [data-status-dot] {
      color: #f59e0b;
      background: conic-gradient(currentColor 0 50%, transparent 50% 100%);
    }
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip][data-status="in_review"] [data-status-dot] { color: #10b981; }
    [${VIEW_ATTR}="editor-panel"] [data-editor-chip][data-status="done"] [data-status-dot] {
      color: #6366f1;
      background: currentColor;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-foot] {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-token-border-light, rgba(127,127,127,.16));
      background: var(--color-token-main-surface-secondary, transparent);
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-hint] {
      font-size: 11px;
      color: var(--color-token-description-foreground, currentColor);
      opacity: .8;
    }

    [${VIEW_ATTR}="editor-panel"] kbd {
      display: inline-block;
      min-width: 18px;
      padding: 1px 5px;
      border: 1px solid var(--color-token-border-light, rgba(127,127,127,.28));
      border-radius: 4px;
      background: var(--color-token-main-surface-primary, Canvas);
      font: inherit;
      font-size: 10px;
      line-height: 14px;
      text-align: center;
      color: var(--color-token-foreground, currentColor);
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-error] {
      padding: 8px 14px;
      border-top: 1px solid var(--color-token-border-light, rgba(127,127,127,.16));
      background: rgba(239,68,68,.08);
      color: #ef4444;
      font-size: 12px;
    }

    [${VIEW_ATTR}="editor-panel"] [data-editor-comments] {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 0 16px 12px;
    }
    [${VIEW_ATTR}="editor-panel"] [data-editor-comments] [data-comment] {
      border: 1px solid var(--color-token-border-light, rgba(127,127,127,.18));
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--color-token-main-surface-secondary, transparent);
      font-size: 13px;
      line-height: 18px;
    }
    [${VIEW_ATTR}="editor-panel"] [data-editor-comments] [data-comment-meta] {
      font-size: 11px;
      color: var(--color-token-description-foreground, currentColor);
      margin-bottom: 2px;
      opacity: .8;
    }

    [${HEADER_ATTR}="root"] {
      min-width: 0;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-left: calc(var(--padding-toolbar-x, .5rem) + 16px);
      padding-right: var(--padding-toolbar-x, .5rem);
    }

    [${HEADER_ATTR}="identity"] {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      line-height: 18px;
    }

    [${HEADER_ATTR}="identity"] [data-header-title] {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.005em;
      color: var(--color-token-foreground, currentColor);
    }

    [${HEADER_ATTR}="identity"] [data-header-separator] {
      width: 1px;
      height: 14px;
      background: var(--color-token-border-light, rgba(127,127,127,.25));
      flex: none;
    }

    [${HEADER_ATTR}="folder"] {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--color-token-description-foreground, currentColor);
      padding: 3px 6px;
      font: inherit;
    }

    [${HEADER_ATTR}="folder"]:hover,
    [${HEADER_ATTR}="folder"]:focus-visible {
      outline: none;
      background: var(--color-token-list-hover-background, rgba(127,127,127,.10));
      color: var(--color-token-foreground, currentColor);
    }

    [${VIEW_ATTR}="template-grid"] {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }

    [${VIEW_ATTR}="path"] {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace);
      font-size: 13px;
      line-height: 20px;
      overflow-wrap: anywhere;
    }

    [${VIEW_ATTR}="card-path"] {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace);
      font-size: 12px;
      line-height: 18px;
      overflow-wrap: anywhere;
    }

    @media (prefers-color-scheme: light) {
      [${VIEW_ATTR}="issue-card"] {
        box-shadow: 0 1px 0 rgba(0,0,0,.02), 0 1px 1px rgba(0,0,0,.02);
      }
      [${VIEW_ATTR}="issue-card"]:hover {
        box-shadow: 0 1px 0 rgba(0,0,0,.03), 0 2px 6px rgba(0,0,0,.04);
      }
      [${VIEW_ATTR}="editor-backdrop"] {
        background: rgba(15, 15, 15, .18);
      }
      [${VIEW_ATTR}="editor-panel"] {
        box-shadow: 0 12px 32px rgba(0, 0, 0, .10), 0 1px 3px rgba(0, 0, 0, .06);
      }
      [${CONTEXT_MENU_ATTR}="root"],
      [${CONTEXT_MENU_ATTR}="submenu-panel"] {
        box-shadow: 0 6px 20px rgba(0, 0, 0, .08), 0 1px 2px rgba(0, 0, 0, .05);
      }
    }

    html.dark [${VIEW_ATTR}="issue-card"] {
      box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.04);
    }
    html.dark [${VIEW_ATTR}="issue-card"]:hover {
      box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 6px 14px rgba(0,0,0,.08);
    }
  `;
  document.head.appendChild(style);
  return style;
}

function scheduleApply(state) {
  if (state.disposed || state.applyTimer) return;
  state.applyTimer = window.setTimeout(() => {
    state.applyTimer = null;
    if (!state.disposed) applyProjectHomeButtons(state);
  }, 80);
}

function applyProjectHomeButtons(state) {
  const sidebar = mainSidebar();
  if (!sidebar) return;

  const rows = candidateProjectRows(sidebar);
  const activeRows = new Set(rows);
  for (const row of rows) {
    const label = displayLabelFor(row);
    const actionsButton = projectActionsButton(row, label);
    if (!actionsButton) {
      removeHomeButtonForRow(row);
      continue;
    }

    const actionsWrapper = actionsButton.parentElement;
    const actionBar = actionsWrapper?.parentElement;
    if (!(actionsWrapper instanceof HTMLElement) || !(actionBar instanceof HTMLElement)) {
      removeHomeButtonForRow(row);
      continue;
    }

    const path = projectPathFor(row);
    let wrapper = row.querySelector(`[${WRAPPER_ATTR}="true"]`);
    let button = row.querySelector(`[${BUTTON_ATTR}="button"]`);
    if (!(wrapper instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
      wrapper?.remove();
      button?.remove();
      wrapper = createHomeWrapper(actionsWrapper);
      button = createHomeButton(actionsButton);
      wrapper.appendChild(button);
    }

    button.dataset.projectPath = path || "";
    button.dataset.projectLabel = label || basenameFor(path, "Project");
    button.setAttribute("aria-label", `Open Project Home for ${label || basenameFor(path, "Project")}`);
    button.setAttribute("aria-keyshortcuts", "Meta+Shift+H");
    button.title = path ? `Project Home: ${path} (Cmd+Shift+H)` : "Project Home (Cmd+Shift+H)";
    setProjectHomeButtonActive(wrapper, button, state?.current, { path, label });

    if (wrapper.parentElement !== actionBar) {
      actionBar.insertBefore(wrapper, actionsWrapper);
    } else if (wrapper.nextElementSibling !== actionsWrapper) {
      actionBar.insertBefore(wrapper, actionsWrapper);
    }
  }

  document.querySelectorAll(`[${WRAPPER_ATTR}="true"]`).forEach((wrapper) => {
    const row = wrapper.closest("div[role='listitem'][aria-label]");
    if (!(row instanceof HTMLElement) || !activeRows.has(row)) wrapper.remove();
  });
}

function createHomeWrapper(templateWrapper) {
  const wrapper = document.createElement("div");
  wrapper.setAttribute(WRAPPER_ATTR, "true");
  wrapper.className = templateWrapper.className || "pr-0.5";
  return wrapper;
}

function createHomeButton(templateButton) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(BUTTON_ATTR, "button");
  button.setAttribute("aria-label", "Open Project Home");
  if (templateButton instanceof HTMLElement) {
    button.className = templateButton.className;
  }
  button.innerHTML = homeIconSvg();
  return button;
}

function setProjectHomeButtonActive(wrapper, button, current, project) {
  const active = sameProject(current, {
    path: project.path || project.label,
    label: project.label || basenameFor(project.path, "Project"),
  });
  for (const node of [wrapper, button]) {
    if (!(node instanceof HTMLElement)) continue;
    if (active) {
      node.setAttribute(ACTIVE_ATTR, "true");
    } else {
      node.removeAttribute(ACTIVE_ATTR);
    }
  }
  if (button instanceof HTMLButtonElement) {
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function syncProjectHomeSidebarState(state) {
  const active = !!state.current;
  if (active) {
    document.body.setAttribute(ACTIVE_ATTR, "true");
  } else {
    document.body.removeAttribute(ACTIVE_ATTR);
  }
  applyProjectHomeButtons(state);
}

function openProjectHomeFromButton(state, button) {
  const row = button.closest("div[role='listitem'][aria-label]");

  const label = button.dataset.projectLabel || (row ? displayLabelFor(row) : "") || "Project";
  const path = button.dataset.projectPath || (row ? projectPathFor(row) : "") || label;
  openProjectHome(state, path, label);
}

function openProjectHome(state, path, label) {
  state.restoreTarget = captureRestoreTarget();
  state.current = { label, path };
  state.board = null;
  state.boardError = "";
  syncProjectHomeSidebarState(state);
  pushProjectHomeUrl(path, label);
  renderProjectHomeView(state);
  loadProjectHomeBoard(state, state.current);
  state.api.log.info("[project-home] opened", { path });
}

function renderProjectHomeView(state) {
  const project = state.current;
  if (!project) {
    removeProjectHomeView(state);
    return;
  }

  const token = ++state.renderToken;
  let root = state.view;
  if (!(root instanceof HTMLElement)) {
    root = document.createElement("div");
    root.setAttribute(VIEW_ATTR, "root");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Project Home");
    state.view = root;
  }

  root.replaceChildren();

  const scroll = document.createElement("div");
  scroll.setAttribute(VIEW_ATTR, "scroll");
  scroll.className = "relative flex min-h-0 flex-1 flex-col";

  const contentBlock = document.createElement("div");
  contentBlock.className =
    "relative flex min-h-0 w-full flex-1 flex-col";

  try {
    if (state.boardError) {
      contentBlock.append(renderProjectHomeError(state.boardError));
    } else if (state.viewMode === "list") {
      contentBlock.append(renderIssueList(state, project));
    } else {
      contentBlock.append(renderIssueBoard(state, project));
    }

    if (state.editor) contentBlock.append(renderIssueEditor(state));
  } catch (error) {
    state.boardError = error?.message || String(error);
    contentBlock.replaceChildren(renderProjectHomeError(state.boardError));
    state.api.log.error("[project-home] render failed", { error: state.boardError });
  }

  scroll.append(contentBlock);
  root.append(scroll);
  scheduleProjectHomeMounts(state, project, token);
}

function renderProjectHomeError(message) {
  const error = document.createElement("div");
  error.className =
    "m-2 rounded-lg border border-token-border bg-token-input-background px-3 py-3 text-sm text-token-description-foreground";
  error.textContent = message;
  return error;
}

function renderIssueBoard(state, project) {
  const board = document.createElement("div");
  board.setAttribute(VIEW_ATTR, "board");
  board.setAttribute("aria-label", "Project issues");

  const issues = Array.isArray(state.board?.issues) ? state.board.issues : [];
  for (const column of visibleIssueColumns(state)) {
    const columnEl = document.createElement("section");
    columnEl.setAttribute(COLUMN_ATTR, column.id);
    columnEl.dataset.status = column.id;
    columnEl.className = "flex min-h-0 flex-col overflow-hidden";

    const header = document.createElement("div");
    header.setAttribute("data-column-header", "true");
    header.className = "flex shrink-0 items-center justify-between gap-2";

    const title = document.createElement("div");
    title.className = "flex min-w-0 items-center gap-2";
    const dot = document.createElement("span");
    dot.setAttribute("data-status-dot", "");
    dot.setAttribute("aria-hidden", "true");
    const titleText = document.createElement("span");
    titleText.setAttribute("data-column-title", "");
    titleText.className = "truncate";
    titleText.textContent = column.title;
    const count = document.createElement("span");
    count.setAttribute("data-column-count", "");
    count.textContent = String(issues.filter((issue) => issue.status === column.id).length);
    title.append(dot, titleText, count);

    const add = document.createElement("button");
    add.type = "button";
    add.className =
      "flex size-6 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-token-border focus-visible:outline-2";
    add.setAttribute("aria-label", `Create issue in ${column.title}`);
    add.innerHTML = plusIconSvg();
    add.addEventListener("click", (event) => {
      event.preventDefault();
      openIssueEditor(state, { mode: "create", status: column.id });
    });

    header.append(title, add);

    const list = document.createElement("div");
    list.className = "flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 py-2";
    list.addEventListener("dragover", (event) => {
      event.preventDefault();
      columnEl.dataset.dropActive = "true";
    });
    list.addEventListener("dragleave", () => {
      columnEl.removeAttribute("data-drop-active");
    });
    list.addEventListener("drop", (event) => {
      event.preventDefault();
      columnEl.removeAttribute("data-drop-active");
      const issueId = event.dataTransfer?.getData("text/plain") || state.dragIssueId;
      if (issueId) moveIssue(state, issueId, column.id);
    });

    const columnIssues = issues
      .filter((issue) => issue.status === column.id)
      .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    for (const issue of columnIssues) {
      list.append(renderIssueCard(state, project, issue));
    }
    if (columnIssues.length === 0) {
      const empty = document.createElement("div");
      empty.className =
        "flex min-h-16 items-center justify-center px-3 text-center text-xs text-token-description-foreground opacity-60";
      empty.textContent = state.boardLoading ? "Loading..." : "No issues";
      list.append(empty);
    }

    columnEl.append(header, list);
    board.append(columnEl);
  }

  return board;
}

function renderIssueList(state, project) {
  const wrap = document.createElement("div");
  wrap.setAttribute(VIEW_ATTR, "list");
  wrap.setAttribute("aria-label", "Project issue list");

  const visible = visibleIssueColumns(state);
  const allIssues = state.board?.issues || [];
  const total = allIssues.filter((issue) => visible.some((c) => c.id === issue.status)).length;

  if (total === 0 && state.boardLoading) {
    const empty = document.createElement("div");
    empty.className = "flex h-40 items-center justify-center text-sm text-token-description-foreground";
    empty.textContent = "Loading...";
    wrap.append(empty);
    return wrap;
  }

  for (const column of visible) {
    const sectionIssues = allIssues
      .filter((issue) => issue.status === column.id)
      .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));

    const section = document.createElement("section");
    section.setAttribute("data-list-section", column.id);
    section.dataset.status = column.id;
    const collapsed = state.collapsedSections?.has(column.id);
    if (collapsed) section.dataset.collapsed = "true";

    const sectionHeader = document.createElement("button");
    sectionHeader.type = "button";
    sectionHeader.setAttribute("data-list-section-header", "");
    sectionHeader.setAttribute("aria-expanded", String(!collapsed));
    sectionHeader.addEventListener("click", () => {
      toggleSectionCollapsed(state, column.id);
    });

    const headerLeft = document.createElement("div");
    headerLeft.className = "flex min-w-0 items-center gap-2";
    const caret = document.createElement("span");
    caret.setAttribute("data-list-section-caret", "");
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML = caretRightIconSvg();
    const dot = document.createElement("span");
    dot.setAttribute("data-status-dot", "");
    dot.setAttribute("aria-hidden", "true");
    const titleText = document.createElement("span");
    titleText.setAttribute("data-list-section-title", "");
    titleText.textContent = column.title;
    const count = document.createElement("span");
    count.setAttribute("data-list-section-count", "");
    count.textContent = String(sectionIssues.length);
    headerLeft.append(caret, dot, titleText, count);

    const add = document.createElement("button");
    add.type = "button";
    add.className =
      "flex size-5 items-center justify-center rounded text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground";
    add.setAttribute("aria-label", `Create issue in ${column.title}`);
    add.innerHTML = plusIconSvg();
    add.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openIssueEditor(state, { mode: "create", status: column.id });
    });

    sectionHeader.append(headerLeft, add);
    section.append(sectionHeader);

    const body = document.createElement("div");
    body.setAttribute("data-list-section-body", "");
    body.addEventListener("dragover", (event) => {
      if (!state.dragIssueId) return;
      event.preventDefault();
      section.dataset.dropActive = "true";
    });
    body.addEventListener("dragleave", (event) => {
      if (event.target !== body) return;
      section.removeAttribute("data-drop-active");
    });
    body.addEventListener("drop", (event) => {
      event.preventDefault();
      section.removeAttribute("data-drop-active");
      const issueId = event.dataTransfer?.getData("text/plain") || state.dragIssueId;
      if (issueId) moveIssue(state, issueId, column.id);
    });

    if (sectionIssues.length === 0) {
      const empty = document.createElement("div");
      empty.setAttribute("data-list-empty", "");
      empty.textContent = "No issues";
      body.append(empty);
    } else {
      for (const issue of sectionIssues) {
        body.append(renderIssueRow(state, issue));
      }
    }

    section.append(body);
    wrap.append(section);
  }

  return wrap;
}

function renderIssueRow(state, issue) {
  const row = document.createElement("div");
  row.setAttribute(VIEW_ATTR, "list-row");
  row.dataset.status = issue.status || "backlog";
  row.dataset.issueId = issue.id;
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.draggable = true;
  row.addEventListener("click", () => openIssueEditor(state, { mode: "edit", issue }));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openIssueEditor(state, { mode: "edit", issue });
    }
  });
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openIssueContextMenu(state, issue, event.clientX, event.clientY);
  });
  row.addEventListener("dragstart", (event) => {
    state.dragIssueId = issue.id;
    row.dataset.dragging = "true";
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", issue.id);
    }
  });
  row.addEventListener("dragend", () => {
    state.dragIssueId = null;
    row.removeAttribute("data-dragging");
    document.querySelectorAll(`[data-list-section][data-drop-active="true"]`)
      .forEach((node) => node.removeAttribute("data-drop-active"));
  });

  const statusCell = document.createElement("span");
  statusCell.setAttribute("data-list-cell", "status");
  const statusDot = document.createElement("span");
  statusDot.setAttribute("data-status-dot", "");
  statusDot.setAttribute("aria-hidden", "true");
  statusCell.append(statusDot);

  const idCell = document.createElement("span");
  idCell.setAttribute("data-list-cell", "id");
  idCell.textContent = issue.id;

  const titleCell = document.createElement("span");
  titleCell.setAttribute("data-list-cell", "title");
  titleCell.textContent = issue.title || "Untitled issue";

  const priorityCell = document.createElement("span");
  priorityCell.setAttribute("data-list-cell", "priority");
  if (issue.priority && issue.priority !== "none") {
    priorityCell.dataset.priority = issue.priority;
    priorityCell.textContent = priorityLabel(issue.priority);
  }

  const dueCell = document.createElement("span");
  dueCell.setAttribute("data-list-cell", "due");
  const dueText = formatDueDate(issue.dueDate);
  if (dueText) {
    dueCell.textContent = dueText;
    if (dueDateClass(issue.dueDate).includes("red")) dueCell.dataset.overdue = "true";
  }

  const assigneeCell = document.createElement("span");
  assigneeCell.setAttribute("data-list-cell", "assignee");
  assigneeCell.textContent = issue.assignee || "";

  row.append(statusCell, idCell, titleCell, priorityCell, dueCell, assigneeCell);
  return row;
}

function listCell(text, className) {
  const cell = document.createElement("span");
  cell.className = className || "";
  cell.textContent = text;
  return cell;
}

function renderIssueEditor(state) {
  const editor = state.editor || {};
  const issue = editor.issue || {};
  const isEdit = editor.mode === "edit" && issue.id;
  const mode = isEdit ? "edit" : "create";

  const backdrop = document.createElement("div");
  backdrop.setAttribute(VIEW_ATTR, "editor-backdrop");
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) closeIssueEditor(state);
  });

  const panel = document.createElement("div");
  panel.setAttribute(VIEW_ATTR, "editor-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", isEdit ? `Edit ${issue.id}` : "New issue");

  const form = document.createElement("form");
  form.className = "flex min-h-0 flex-1 flex-col";

  // Head: project crumb + status chip + close
  const head = document.createElement("div");
  head.setAttribute("data-editor-head", "");

  const crumb = document.createElement("div");
  crumb.setAttribute("data-editor-crumb", "");
  crumb.innerHTML = folderIconSvg();
  const crumbName = document.createElement("span");
  crumbName.textContent = basenameFor(state.current?.path, state.current?.label || "Project");
  crumb.append(crumbName);
  if (isEdit) {
    const sep = document.createElement("span");
    sep.textContent = " / ";
    sep.style.opacity = ".5";
    const idBadge = document.createElement("span");
    idBadge.style.fontFamily = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)";
    idBadge.style.textTransform = "uppercase";
    idBadge.textContent = issue.id;
    crumb.append(sep, idBadge);
  }

  const headSpacer = document.createElement("div");
  headSpacer.style.flex = "1";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className =
    "flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = xIconSvg();
  closeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    closeIssueEditor(state);
  });

  head.append(crumb, headSpacer, closeBtn);

  // Body: title + description (borderless)
  const body = document.createElement("div");
  body.setAttribute("data-editor-body", "");

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.name = "title";
  titleInput.required = true;
  titleInput.placeholder = "Issue title";
  titleInput.setAttribute("data-editor-title", "");
  titleInput.value = issue.title || "";
  titleInput.autocomplete = "off";

  const descInput = document.createElement("textarea");
  descInput.name = "description";
  descInput.placeholder = "Add description...";
  descInput.setAttribute("data-editor-description", "");
  descInput.rows = 3;
  descInput.value = issue.description || "";
  // auto-grow
  const autoGrow = () => {
    descInput.style.height = "auto";
    descInput.style.height = `${Math.min(280, descInput.scrollHeight)}px`;
  };
  descInput.addEventListener("input", autoGrow);
  window.setTimeout(autoGrow, 0);

  body.append(titleInput, descInput);

  // Optional: existing comments + new comment
  if (isEdit) {
    const comments = Array.isArray(issue.comments) ? issue.comments : [];
    if (comments.length > 0) {
      const commentsWrap = document.createElement("div");
      commentsWrap.setAttribute("data-editor-comments", "");
      for (const comment of comments) {
        const item = document.createElement("article");
        item.setAttribute("data-comment", "");
        const meta = document.createElement("div");
        meta.setAttribute("data-comment-meta", "");
        const author = (comment.author || "").trim();
        const when = formatDateTime(comment.createdAt);
        meta.textContent = author ? `${author} · ${when}` : when;
        const text = document.createElement("div");
        text.textContent = comment.body || "";
        item.append(meta, text);
        commentsWrap.append(item);
      }
      body.append(commentsWrap);
    }
    const commentRow = document.createElement("div");
    commentRow.style.padding = "0 16px 8px";
    const commentInput = document.createElement("textarea");
    commentInput.name = "newComment";
    commentInput.placeholder = "Add a comment...";
    commentInput.rows = 1;
    commentInput.setAttribute("data-editor-description", "");
    commentInput.style.minHeight = "32px";
    commentInput.style.borderTop = "1px solid var(--color-token-border-light, rgba(127,127,127,.16))";
    commentInput.style.paddingTop = "8px";
    const commentAutoGrow = () => {
      commentInput.style.height = "auto";
      commentInput.style.height = `${Math.max(32, Math.min(280, commentInput.scrollHeight))}px`;
    };
    commentInput.addEventListener("input", commentAutoGrow);
    window.setTimeout(commentAutoGrow, 0);
    commentRow.append(commentInput);
    body.append(commentRow);
  }

  // Toolbar: chips for status / priority / due / assignee / labels
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-editor-toolbar", "");

  const statusChip = createStatusChip(issue.status || editor.status || "backlog");
  const priorityChip = createPriorityChip(issue.priority || "none");
  const dueChip = createDueDateChip(issue.dueDate || "");
  const assigneeChip = createTextChip("assignee", issue.assignee || "", "Assignee", personIconSvg());
  const labelsChip = createTextChip(
    "labels",
    Array.isArray(issue.labels) ? issue.labels.join(", ") : (issue.labels || ""),
    "Labels",
    tagIconSvg(),
    { placeholder: "bug, ui" },
  );

  toolbar.append(statusChip, priorityChip, dueChip, assigneeChip, labelsChip);

  // Error
  const error = document.createElement("div");
  error.setAttribute("data-editor-error", "");
  error.style.display = "none";
  error.setAttribute("role", "alert");

  // Footer
  const foot = document.createElement("div");
  foot.setAttribute("data-editor-foot", "");

  const hint = document.createElement("div");
  hint.setAttribute("data-editor-hint", "");
  const hintParts = [];
  hintParts.push('<kbd>⌘</kbd><kbd>↵</kbd> to ' + (isEdit ? "save" : "create"));
  hintParts.push('<kbd>Esc</kbd> to close');
  hint.innerHTML = hintParts.join(" · ");

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.alignItems = "center";
  actions.style.gap = "8px";

  if (isEdit) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className =
      "rounded-md px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!window.confirm(`Delete ${issue.id}?`)) return;
      try {
        await mutateBoard(state, IPC_ISSUE_DELETE, {
          projectPath: state.current?.path,
          issueId: issue.id,
        });
        closeIssueEditor(state);
      } catch (caught) {
        showError(caught);
      }
    });
    actions.append(deleteBtn);
  }

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className =
    "rounded-md px-2.5 py-1.5 text-xs text-token-foreground hover:bg-token-list-hover-background";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeIssueEditor(state));

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className =
    "rounded-md bg-token-text-primary px-3 py-1.5 text-xs font-medium text-token-main-surface-primary hover:opacity-90";
  submit.textContent = isEdit ? "Save" : "Create issue";

  actions.append(cancel, submit);
  foot.append(hint, actions);

  function showError(value) {
    error.textContent = value?.message || String(value);
    error.style.display = "block";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = readIssueFormValue(form);
    if (!value.title) {
      showError("Title is required.");
      titleInput.focus();
      return;
    }
    error.style.display = "none";
    try {
      submit.disabled = true;
      if (isEdit) {
        await mutateBoard(state, IPC_ISSUE_UPDATE, {
          ...value,
          projectPath: state.current?.path,
          issueId: issue.id,
        });
      } else {
        await mutateBoard(state, IPC_ISSUE_CREATE, {
          ...value,
          projectPath: state.current?.path,
        });
      }
      closeIssueEditor(state);
    } catch (caught) {
      submit.disabled = false;
      showError(caught);
    }
  });

  // Cmd/Ctrl + Enter to submit from anywhere in the form
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit?.() || submit.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeIssueEditor(state);
    }
  });

  form.append(head, body, toolbar, error, foot);
  panel.append(form);
  backdrop.append(panel);

  window.setTimeout(() => {
    titleInput.focus();
    if (!isEdit) titleInput.select();
  }, 0);

  return backdrop;
}

function createStatusChip(value) {
  const chip = document.createElement("label");
  chip.setAttribute("data-editor-chip", "");
  chip.dataset.status = value;
  const dot = document.createElement("span");
  dot.setAttribute("data-status-dot", "");
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = columnTitle(value);
  const select = document.createElement("select");
  select.name = "status";
  for (const column of ISSUE_COLUMNS) {
    const opt = document.createElement("option");
    opt.value = column.id;
    opt.textContent = column.title;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener("change", () => {
    chip.dataset.status = select.value;
    text.textContent = columnTitle(select.value);
  });
  chip.append(dot, text, select);
  return chip;
}

function createPriorityChip(value) {
  const chip = document.createElement("label");
  chip.setAttribute("data-editor-chip", "");
  const icon = document.createElement("span");
  icon.innerHTML = priorityIconSvg();
  const text = document.createElement("span");
  text.textContent = priorityLabel(value);
  const select = document.createElement("select");
  select.name = "priority";
  for (const priority of ISSUE_PRIORITIES) {
    const opt = document.createElement("option");
    opt.value = priority;
    opt.textContent = priorityLabel(priority);
    select.append(opt);
  }
  select.value = value;
  select.addEventListener("change", () => {
    text.textContent = priorityLabel(select.value);
  });
  chip.append(icon, text, select);
  return chip;
}

function createDueDateChip(value) {
  const chip = document.createElement("label");
  chip.setAttribute("data-editor-chip", "");
  const icon = document.createElement("span");
  icon.innerHTML = calendarIconSvg();
  const text = document.createElement("span");
  text.textContent = value ? formatDueDate(value) : "Due date";
  const input = document.createElement("input");
  input.type = "date";
  input.name = "dueDate";
  input.value = value || "";
  input.addEventListener("change", () => {
    text.textContent = input.value ? formatDueDate(input.value) : "Due date";
  });
  chip.append(icon, text, input);
  return chip;
}

function createTextChip(name, value, placeholder, icon, options = {}) {
  const chip = document.createElement("label");
  chip.setAttribute("data-editor-chip", "");
  const iconEl = document.createElement("span");
  iconEl.innerHTML = icon;
  const text = document.createElement("span");
  text.textContent = value || placeholder;
  if (!value) text.style.opacity = ".7";
  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = value || "";
  input.placeholder = options.placeholder || "";
  input.addEventListener("input", () => {
    if (input.value) {
      text.textContent = input.value;
      text.style.opacity = "1";
    } else {
      text.textContent = placeholder;
      text.style.opacity = ".7";
    }
  });
  chip.append(iconEl, text, input);
  return chip;
}

function readIssueFormValue(form) {
  const data = new FormData(form);
  return {
    title: String(data.get("title") || "").trim(),
    description: String(data.get("description") || "").trim(),
    status: String(data.get("status") || "backlog"),
    priority: String(data.get("priority") || "none"),
    labels: String(data.get("labels") || "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
    assignee: String(data.get("assignee") || "").trim(),
    dueDate: String(data.get("dueDate") || "").trim(),
    newComment: String(data.get("newComment") || "").trim(),
  };
}

function renderIssueCard(state, project, issue) {
  const card = document.createElement("article");
  card.setAttribute(VIEW_ATTR, "issue-card");
  card.setAttribute(ISSUE_CARD_ATTR, issue.id);
  card.setAttribute("draggable", "true");
  card.setAttribute("tabindex", "0");
  card.dataset.issueId = issue.id;
  card.dataset.status = issue.status || "backlog";
  card.className = "group flex flex-col gap-1.5 px-3 py-2.5";
  card.addEventListener("dragstart", (event) => {
    state.dragIssueId = issue.id;
    card.dataset.dragging = "true";
    event.dataTransfer?.setData("text/plain", issue.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    state.dragIssueId = "";
    card.removeAttribute("data-dragging");
    document.querySelectorAll(`[${COLUMN_ATTR}][data-drop-active="true"]`)
      .forEach((node) => node.removeAttribute("data-drop-active"));
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openIssueContextMenu(state, issue, event.clientX, event.clientY);
  });
  card.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    openIssueEditor(state, { mode: "edit", issue });
  });

  const top = document.createElement("div");
  top.className = "flex items-center justify-between gap-2";

  const idWrap = document.createElement("div");
  idWrap.className = "flex min-w-0 items-center gap-2";
  const dot = document.createElement("span");
  dot.setAttribute("data-status-dot", "");
  dot.setAttribute("aria-hidden", "true");
  const id = document.createElement("div");
  id.setAttribute(VIEW_ATTR, "issue-id");
  id.textContent = issue.id;
  idWrap.append(dot, id);

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className =
    "flex size-6 items-center justify-center rounded-md text-token-description-foreground opacity-0 hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:opacity-100 focus-visible:outline-token-border focus-visible:outline-2 group-hover:opacity-100";
  menu.setAttribute("aria-label", `Issue actions for ${issue.id}`);
  menu.innerHTML = ellipsisIconSvg();
  menu.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = menu.getBoundingClientRect();
    openIssueContextMenu(state, issue, rect.left, rect.bottom + 4);
  });
  top.append(idWrap, menu);

  const title = document.createElement("div");
  title.setAttribute("data-issue-title", "");
  title.className = "text-token-foreground";
  title.textContent = issue.title || "Untitled issue";

  card.append(top, title);

  if (issue.description) {
    const description = document.createElement("div");
    description.setAttribute(VIEW_ATTR, "issue-description");
    description.className = "line-clamp-2 text-xs leading-5 text-token-description-foreground opacity-80";
    description.textContent = issue.description;
    card.append(description);
  }

  const meta = document.createElement("div");
  meta.setAttribute(VIEW_ATTR, "issue-meta");
  meta.className = "flex flex-wrap items-center gap-1";
  const priorityValue = String(issue.priority || "none").toLowerCase();
  if (priorityValue && priorityValue !== "none") {
    meta.append(issuePill(priorityLabel(issue.priority), { priority: priorityValue }));
  }
  if (issue.dueDate) {
    const overdue = dueDateClass(issue.dueDate).includes("red");
    meta.append(issuePill(formatDueDate(issue.dueDate), { overdue }));
  }
  for (const label of issue.labels || []) meta.append(issueLabelPill(label));
  if (issue.assignee) meta.append(issuePill(issue.assignee));
  if (Array.isArray(issue.comments) && issue.comments.length > 0) {
    meta.append(issuePill(`${issue.comments.length}`));
  }
  if (meta.childNodes.length > 0) card.append(meta);

  card.addEventListener("dblclick", (event) => {
    event.preventDefault();
    openIssueEditor(state, { mode: "edit", issue });
  });

  return card;
}

function issuePill(text, options = {}) {
  const pill = document.createElement("span");
  pill.setAttribute("data-pill", "");
  if (typeof options === "string") {
    if (options) pill.className = options;
  } else {
    if (options.priority) pill.setAttribute("data-pill-priority", options.priority);
    if (options.overdue) pill.setAttribute("data-pill-overdue", "true");
    if (options.className) pill.className = options.className;
  }
  pill.textContent = text || "None";
  return pill;
}

function issueLabelPill(label) {
  const value = String(label || "").trim();
  const pill = document.createElement("span");
  pill.setAttribute("data-pill", "");
  pill.setAttribute("data-pill-label", "");
  const hue = labelHue(value);
  pill.style.setProperty("--label-hue", String(hue));
  const dot = document.createElement("span");
  dot.setAttribute("data-label-dot", "");
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = value || "label";
  pill.append(dot, text);
  return pill;
}

function labelHue(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

function projectHomeToolbarButton(label, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "flex size-8 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-token-border focus-visible:outline-2";
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  return button;
}

async function loadProjectHomeBoard(state, project, options = {}) {
  if (!project?.path || state.disposed) return;
  if (state.boardLoading && !options.force) return;
  state.boardLoading = true;
  state.boardError = "";
  try {
    const board = await state.api.ipc.invoke(IPC_BOARD_LIST, { projectPath: project.path });
    if (state.disposed || !sameProject(state.current, project)) return;
    state.board = normalizeBoard(board);
  } catch (error) {
    if (state.disposed || !sameProject(state.current, project)) return;
    state.boardError = `Could not load issues: ${error?.message || String(error)}`;
  } finally {
    if (!state.disposed && sameProject(state.current, project)) {
      state.boardLoading = false;
      renderProjectHomeView(state);
    }
  }
}

async function moveIssue(state, issueId, status) {
  const project = state.current;
  if (!project?.path || !issueId || !status) return;
  ensureStatusVisible(state, status);
  await mutateBoard(state, IPC_ISSUE_MOVE, {
    projectPath: project.path,
    issueId,
    status,
  });
}

async function setIssueLabels(state, issue, labels) {
  if (!state.current?.path || !issue?.id) return;
  await mutateBoard(state, IPC_ISSUE_UPDATE, {
    projectPath: state.current.path,
    issueId: issue.id,
    labels,
  });
}

function toggleIssueLabel(state, issue, label, forceAdd = false) {
  const value = String(label || "").trim();
  if (!value) return;
  const labels = new Set(Array.isArray(issue.labels) ? issue.labels : []);
  if (labels.has(value) && !forceAdd) labels.delete(value);
  else labels.add(value);
  setIssueLabels(state, issue, Array.from(labels));
}

function openNewChatFromIssue(state, issue) {
  const target = findNewChatButton();
  if (!target) return;
  const prompt = issueChatPrompt(state.current, issue);
  dismissProjectHomeForNativeNavigation(state, target, { activate: true });
  for (const delay of [150, 400, 800, 1400, 2200]) {
    window.setTimeout(() => {
      const input = findComposerInput();
      if (input && setComposerText(input, prompt)) {
        input.focus();
      }
    }, delay);
  }
}

function issueChatPrompt(project, issue) {
  const projectPath = project?.path || project?.label || "";
  return [
    `Read issue ${issue.id} using the project_home MCP and help me work through it.`,
    `projectPath: "${projectPath}"`,
    "",
    "Move it to `in_progress` when you start, leave comments with `author: \"Codex\"` for meaningful steps, and move it to `in_review` or `done` when finished.",
  ].join("\n");
}

function findComposerInput() {
  const candidates = Array.from(document.querySelectorAll([
    "textarea",
    "input[type='text']",
    "[contenteditable='true']",
    "[role='textbox']",
  ].join(","))).filter((node) =>
    node instanceof HTMLElement &&
    visible(node) &&
    !node.closest(`[${VIEW_ATTR}="root"],[${CONTEXT_MENU_ATTR}="root"]`));
  return candidates.find((node) => {
    const label = normalize(node.getAttribute("aria-label") || node.getAttribute("placeholder") || "");
    return label.includes("message") || label.includes("prompt") || label.includes("ask") || node.tagName === "TEXTAREA";
  }) || candidates[0] || null;
}

function setComposerText(input, text) {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (input instanceof HTMLElement && input.isContentEditable) {
    input.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }
  return false;
}

async function mutateBoard(state, channel, payload) {
  try {
    if (payload?.status) ensureStatusVisible(state, payload.status);
    const result = await state.api.ipc.invoke(channel, payload);
    const board = result?.board || result;
    if (board) state.board = normalizeBoard(board);
    state.boardError = "";
    renderProjectHomeView(state);
  } catch (error) {
    state.boardError = error?.message || String(error);
    renderProjectHomeView(state);
  }
}

function ensureStatusVisible(state, status) {
  const value = String(status || "").trim();
  if (!value || state.visibleColumns?.has?.(value)) return;
  const next = new Set(state.visibleColumns);
  next.add(value);
  state.visibleColumns = next;
  state.api.storage?.set?.(VISIBLE_COLUMNS_STORAGE_KEY, Array.from(next));
  state.headerSignature = "";
}

function normalizeBoard(board) {
  return {
    columns: Array.isArray(board?.columns) ? board.columns : ISSUE_COLUMNS,
    issues: Array.isArray(board?.issues) ? board.issues : [],
  };
}

function openIssueContextMenu(state, issue, x, y) {
  closeProjectHomeContextMenu(state);
  const menu = document.createElement("div");
  menu.setAttribute(CONTEXT_MENU_ATTR, "root");
  menu.setAttribute("role", "menu");

  menu.append(contextMenuItem("Edit details", editIconSvg(), () =>
    openIssueEditor(state, { mode: "edit", issue })));
  menu.append(contextMenuSubmenu("Change status", columnsIconSvg(),
    ISSUE_COLUMNS.map((column) => ({
      label: column.title,
      checked: column.id === issue.status,
      action: () => moveIssue(state, issue.id, column.id),
    }))));
  menu.append(contextMenuSubmenu("Labels", tagIconSvg(),
    labelMenuItems(state, issue)));
  menu.append(contextMenuSubmenu("Copy", copyIconSvg(),
    issueCopyMenuItems(issue)));
  menu.append(contextMenuItem("New chat from issue", messageIconSvg(), () =>
    openNewChatFromIssue(state, issue)));
  menu.append(contextMenuItem("Delete issue", trashIconSvg(), async () => {
    if (!window.confirm(`Delete ${issue.id}?`)) return;
    await mutateBoard(state, IPC_ISSUE_DELETE, {
      projectPath: state.current?.path,
      issueId: issue.id,
    });
  }));

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  state.contextMenu = menu;
  window.setTimeout(() => installContextMenuDismiss(state, menu), 0);
}

function findHoveredIssue(state) {
  if (!state.view) return null;
  const node = state.view.querySelector("[data-issue-id]:hover");
  if (!node) return null;
  const issueId = node.dataset.issueId || node.getAttribute("data-issue-id");
  if (!issueId) return null;
  const issue = (state.board?.issues || []).find((item) => item.id === issueId);
  if (!issue) return null;
  return { issue, element: node };
}

function openIssuePropertySheet(state, issue, kind, anchor) {
  closeProjectHomeContextMenu(state);
  const menu = document.createElement("div");
  menu.setAttribute(CONTEXT_MENU_ATTR, "root");
  menu.setAttribute("role", "menu");
  menu.dataset.propertySheet = kind;

  if (kind === "status") {
    appendSheetHeader(menu, "Set status");
    appendSheetSearch(menu, "Filter status\u2026");
    for (const column of ISSUE_COLUMNS) {
      menu.append(contextMenuItem(
        column.title,
        column.id === issue.status ? checkIconSvg() : emptyIconSvg(),
        () => moveIssue(state, issue.id, column.id),
      ));
    }
  } else if (kind === "priority") {
    appendSheetHeader(menu, "Set priority");
    appendSheetSearch(menu, "Filter priority\u2026");
    for (const priority of ISSUE_PRIORITIES) {
      menu.append(contextMenuItem(
        priorityLabel(priority),
        priority === (issue.priority || "none") ? checkIconSvg() : emptyIconSvg(),
        () => updateIssueField(state, issue, { priority }),
      ));
    }
  } else if (kind === "due") {
    appendSheetHeader(menu, "Set due date");
    const wrap = document.createElement("div");
    wrap.style.padding = "8px";
    const input = document.createElement("input");
    input.type = "date";
    input.value = issue.dueDate || "";
    input.style.width = "100%";
    input.style.padding = "6px 8px";
    input.style.border = "1px solid var(--color-token-border, rgba(0,0,0,.18))";
    input.style.borderRadius = "6px";
    input.style.background = "transparent";
    input.style.color = "inherit";
    input.style.font = "inherit";
    input.addEventListener("change", () => {
      updateIssueField(state, issue, { dueDate: input.value || "" });
      closeProjectHomeContextMenu(state);
    });
    wrap.append(input);
    menu.append(wrap);
    if (issue.dueDate) {
      menu.append(contextMenuItem("Clear due date", emptyIconSvg(), () =>
        updateIssueField(state, issue, { dueDate: "" })));
    }
    window.setTimeout(() => input.focus(), 0);
  } else if (kind === "assignee") {
    appendSheetHeader(menu, "Set assignee");
    const wrap = document.createElement("div");
    wrap.style.padding = "8px";
    const input = document.createElement("input");
    input.type = "text";
    input.value = issue.assignee || "";
    input.placeholder = "Assignee";
    input.style.width = "100%";
    input.style.padding = "6px 8px";
    input.style.border = "1px solid var(--color-token-border, rgba(0,0,0,.18))";
    input.style.borderRadius = "6px";
    input.style.background = "transparent";
    input.style.color = "inherit";
    input.style.font = "inherit";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        updateIssueField(state, issue, { assignee: input.value.trim() });
        closeProjectHomeContextMenu(state);
      }
    });
    wrap.append(input);
    menu.append(wrap);
    if (issue.assignee) {
      menu.append(contextMenuItem("Clear assignee", emptyIconSvg(), () =>
        updateIssueField(state, issue, { assignee: "" })));
    }
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  } else if (kind === "labels") {
    appendSheetHeader(menu, "Toggle labels");
    appendSheetSearch(menu, "Filter labels\u2026");
    for (const item of labelMenuItems(state, issue)) {
      menu.append(contextMenuItem(
        item.label,
        item.checked ? checkIconSvg() : emptyIconSvg(),
        item.action,
      ));
    }
  }

  document.body.append(menu);
  positionSheetNearAnchor(menu, anchor);
  state.contextMenu = menu;
  window.setTimeout(() => installContextMenuDismiss(state, menu), 0);
}

function appendSheetHeader(menu, label) {
  const header = document.createElement("div");
  header.style.padding = "6px 10px 4px";
  header.style.fontSize = "11px";
  header.style.fontWeight = "600";
  header.style.letterSpacing = ".04em";
  header.style.textTransform = "uppercase";
  header.style.color = "var(--color-token-description-foreground, currentColor)";
  header.style.opacity = ".7";
  header.textContent = label;
  menu.append(header);
}

function appendSheetSearch(menu, placeholder) {
  const wrap = document.createElement("div");
  wrap.setAttribute(CONTEXT_MENU_ATTR, "search");
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute(CONTEXT_MENU_ATTR, "search-input");
  input.placeholder = placeholder || "Search\u2026";
  input.spellcheck = false;
  input.autocomplete = "off";
  wrap.append(input);
  menu.append(wrap);

  const visibleItems = () =>
    Array.from(menu.querySelectorAll(`[${CONTEXT_MENU_ATTR}="item"]`)).filter(
      (it) => !it.hidden,
    );

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const items = menu.querySelectorAll(`[${CONTEXT_MENU_ATTR}="item"]`);
    let anyVisible = false;
    items.forEach((it) => {
      const t = (it.dataset.searchText || it.textContent || "").toLowerCase();
      const match = !q || t.includes(q);
      it.hidden = !match;
      if (match) anyVisible = true;
    });
    let empty = menu.querySelector(`[${CONTEXT_MENU_ATTR}="empty"]`);
    if (!anyVisible && q) {
      if (!empty) {
        empty = document.createElement("div");
        empty.setAttribute(CONTEXT_MENU_ATTR, "empty");
        empty.textContent = "No matches";
        menu.append(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = visibleItems()[0];
      first?.click();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = visibleItems()[0];
      first?.focus();
    }
  });

  window.setTimeout(() => input.focus(), 0);
  return input;
}

function positionSheetNearAnchor(menu, anchor) {
  const a = anchor?.getBoundingClientRect?.();
  const rect = menu.getBoundingClientRect();
  let x = a ? a.left : 24;
  let y = a ? a.bottom + 4 : 24;
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

async function updateIssueField(state, issue, patch) {
  if (!state.current?.path || !issue?.id) return;
  await mutateBoard(state, IPC_ISSUE_UPDATE, {
    projectPath: state.current.path,
    issueId: issue.id,
    ...patch,
  });
}

function confirmDeleteIssue(state, issue) {
  if (!issue?.id || !state.current?.path) return;
  closeProjectHomeContextMenu(state);
  const backdrop = document.createElement("div");
  backdrop.setAttribute(VIEW_ATTR, "editor-backdrop");
  backdrop.dataset.confirm = "delete";

  const panel = document.createElement("div");
  panel.setAttribute(VIEW_ATTR, "editor-panel");
  panel.style.maxWidth = "420px";
  panel.style.width = "min(420px, 100%)";
  panel.style.maxHeight = "none";

  const head = document.createElement("div");
  head.setAttribute("data-editor-head", "");
  const crumb = document.createElement("div");
  crumb.setAttribute("data-editor-crumb", "");
  crumb.textContent = `Delete ${issue.id}`;
  head.append(crumb);
  panel.append(head);

  const body = document.createElement("div");
  body.style.padding = "14px 16px 4px";
  body.style.fontSize = "13px";
  body.style.lineHeight = "20px";
  body.style.color = "var(--color-token-text-primary, currentColor)";
  const title = document.createElement("div");
  title.style.fontWeight = "500";
  title.style.marginBottom = "4px";
  title.textContent = issue.title || "Untitled issue";
  const note = document.createElement("div");
  note.style.color = "var(--color-token-description-foreground, currentColor)";
  note.textContent = "This issue will be permanently deleted. This can't be undone.";
  body.append(title, note);
  panel.append(body);

  const foot = document.createElement("div");
  foot.setAttribute("data-editor-foot", "");
  const hint = document.createElement("div");
  hint.setAttribute("data-editor-hint", "");
  hint.innerHTML = "<kbd>\u21B5</kbd> to delete \u00B7 <kbd>Esc</kbd> to cancel";
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className =
    "rounded-md px-2.5 py-1.5 text-xs text-token-foreground hover:bg-token-list-hover-background";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className =
    "rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500";
  confirm.textContent = "Delete";
  actions.append(cancel, confirm);
  foot.append(hint, actions);
  panel.append(foot);

  backdrop.append(panel);
  document.body.append(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const doDelete = async () => {
    close();
    await mutateBoard(state, IPC_ISSUE_DELETE, {
      projectPath: state.current.path,
      issueId: issue.id,
    });
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      doDelete();
    }
  };
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", doDelete);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  window.setTimeout(() => confirm.focus(), 0);
}

function labelMenuItems(state, issue) {
  const current = new Set(Array.isArray(issue.labels) ? issue.labels : []);
  const known = new Set(DEFAULT_LABELS);
  for (const item of state.board?.issues || []) {
    for (const label of item.labels || []) known.add(label);
  }
  const items = Array.from(known).sort((a, b) => a.localeCompare(b)).map((label) => ({
    label,
    checked: current.has(label),
    action: () => toggleIssueLabel(state, issue, label),
  }));
  items.push({
    label: "Add label...",
    action: () => {
      const label = window.prompt("Label name");
      if (label) toggleIssueLabel(state, issue, label.trim(), true);
    },
  });
  if (current.size > 0) {
    items.push({
      label: "Clear labels",
      action: () => setIssueLabels(state, issue, []),
    });
  }
  return items;
}

function issueCopyMenuItems(issue) {
  const id = issue?.id || "";
  const title = issue?.title || "";
  return [
    {
      label: "Copy title",
      action: () => copyToClipboard(title),
    },
    {
      label: "Copy ID",
      action: () => copyToClipboard(id),
    },
    {
      label: "Copy ID and title",
      action: () => copyToClipboard(`${id} ${title}`.trim()),
    },
    {
      label: "Copy as Markdown link",
      action: () => copyToClipboard(`[${id}](#${id}) ${title}`.trim()),
    },
    {
      label: "Copy full issue",
      action: () => copyToClipboard(formatIssueForCopy(issue)),
    },
  ];
}

function formatIssueForCopy(issue) {
  if (!issue) return "";
  const lines = [];
  lines.push(`${issue.id || ""} \u2014 ${issue.title || "Untitled issue"}`.trim());
  const meta = [];
  if (issue.status) meta.push(`Status: ${columnTitle(issue.status)}`);
  if (issue.priority && issue.priority !== "none") meta.push(`Priority: ${priorityLabel(issue.priority)}`);
  if (issue.dueDate) meta.push(`Due: ${formatDueDate(issue.dueDate)}`);
  if (issue.assignee) meta.push(`Assignee: ${issue.assignee}`);
  if (Array.isArray(issue.labels) && issue.labels.length) meta.push(`Labels: ${issue.labels.join(", ")}`);
  if (meta.length) lines.push(meta.join(" \u00B7 "));
  const description = String(issue.description || "").trim();
  if (description) {
    lines.push("");
    lines.push(description);
  }
  return lines.join("\n");
}

function columnTitle(statusId) {
  const column = ISSUE_COLUMNS.find((c) => c.id === statusId);
  return column?.title || statusId || "";
}

async function copyToClipboard(text) {
  const value = String(text == null ? "" : text);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  } catch {
    return false;
  }
}

function contextMenuSubmenu(label, icon, items) {
  const wrap = document.createElement("div");
  wrap.setAttribute(CONTEXT_MENU_ATTR, "submenu");
  wrap.innerHTML = "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute(CONTEXT_MENU_ATTR, "item");
  trigger.setAttribute("role", "menuitem");
  trigger.innerHTML = icon;
  const text = document.createElement("span");
  text.className = "min-w-0 flex-1 truncate";
  text.textContent = label;
  trigger.append(text);
  trigger.insertAdjacentHTML("beforeend", chevronRightIconSvg());

  const panel = document.createElement("div");
  panel.setAttribute(CONTEXT_MENU_ATTR, "submenu-panel");
  panel.setAttribute("role", "menu");
  for (const item of items) {
    const button = contextMenuItem(item.label, item.checked ? checkIconSvg() : emptyIconSvg(), item.action);
    button.setAttribute("aria-checked", item.checked ? "true" : "false");
    panel.append(button);
  }

  wrap.append(trigger, panel);
  return wrap;
}

function contextMenuItem(label, icon, action) {
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute(CONTEXT_MENU_ATTR, "item");
  item.setAttribute("role", "menuitem");
  item.innerHTML = icon;
  const text = document.createElement("span");
  text.className = "min-w-0 flex-1 truncate";
  text.textContent = label;
  item.append(text);
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const root = item.closest(`[${CONTEXT_MENU_ATTR}="root"]`);
    action();
    root?.remove();
  });
  return item;
}

function closeProjectHomeContextMenu(state) {
  if (state.closeContextMenuOnOutside) {
    document.removeEventListener("pointerdown", state.closeContextMenuOnOutside, true);
    state.closeContextMenuOnOutside = null;
  }
  if (state.closeContextMenuOnKey) {
    document.removeEventListener("keydown", state.closeContextMenuOnKey, true);
    state.closeContextMenuOnKey = null;
  }
  state.contextMenu?.remove();
  state.contextMenu = null;
}

function installContextMenuDismiss(state, menu) {
  document.addEventListener("pointerdown", state.closeContextMenuOnOutside = (event) => {
    if (menu.contains(event.target)) return;
    closeProjectHomeContextMenu(state);
  }, true);
  document.addEventListener("keydown", state.closeContextMenuOnKey = (event) => {
    if (event.key === "Escape") closeProjectHomeContextMenu(state);
  }, true);
}

function priorityLabel(priority) {
  const value = String(priority || "none").replace(/_/g, " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDueDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dueDateClass(value) {
  const text = String(value || "").trim();
  if (!text) return "text-token-description-foreground";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "text-token-description-foreground";
  return date < today ? "text-red-500" : "text-token-description-foreground";
}

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function columnTitle(status) {
  return ISSUE_COLUMNS.find((column) => column.id === status)?.title || status || "Backlog";
}

function visibleIssueColumns(state) {
  const visible = state.visibleColumns instanceof Set ? state.visibleColumns : new Set();
  const columns = ISSUE_COLUMNS.filter((column) => visible.has(column.id));
  return columns.length > 0 ? columns : ISSUE_COLUMNS;
}

function toggleVisibleColumn(state, columnId) {
  const next = new Set(state.visibleColumns);
  if (next.has(columnId) && next.size > 1) next.delete(columnId);
  else next.add(columnId);
  state.visibleColumns = next;
  state.api.storage?.set?.(VISIBLE_COLUMNS_STORAGE_KEY, Array.from(next));
  renderProjectHomeView(state);
  syncHeaderForProjectHome(state);
}

function toggleSectionCollapsed(state, columnId) {
  const next = new Set(state.collapsedSections instanceof Set ? state.collapsedSections : []);
  if (next.has(columnId)) next.delete(columnId);
  else next.add(columnId);
  state.collapsedSections = next;
  state.api.storage?.set?.(COLLAPSED_SECTIONS_STORAGE_KEY, Array.from(next));
  renderProjectHomeView(state);
}

function openIssueEditor(state, editor) {
  state.editor = editor;
  closeProjectHomeContextMenu(state);
  renderProjectHomeView(state);
}

function closeIssueEditor(state) {
  state.editor = null;
  renderProjectHomeView(state);
}

function readStoredViewMode(api) {
  const mode = api.storage?.get?.(VIEW_MODE_STORAGE_KEY, "board");
  return mode === "list" ? "list" : "board";
}

function readStoredVisibleColumns(api) {
  const stored = api.storage?.get?.(VISIBLE_COLUMNS_STORAGE_KEY, null);
  const values = Array.isArray(stored) ? stored : ISSUE_COLUMNS.map((column) => column.id);
  const allowed = new Set(ISSUE_COLUMNS.map((column) => column.id));
  const visible = values.filter((value) => allowed.has(value));
  return new Set(visible.length > 0 ? visible : ISSUE_COLUMNS.map((column) => column.id));
}

function readStoredCollapsedSections(api) {
  const stored = api.storage?.get?.(COLLAPSED_SECTIONS_STORAGE_KEY, null);
  const allowed = new Set(ISSUE_COLUMNS.map((column) => column.id));
  const values = Array.isArray(stored) ? stored.filter((value) => allowed.has(value)) : [];
  return new Set(values);
}

function sameProject(left, right) {
  return !!left && !!right && left.path === right.path && left.label === right.label;
}

function closeProjectHome(state, options = {}) {
  state.ignoreRouteUntil = 0;
  closeProjectHomeContextMenu(state);
  removeProjectHomeView(state, { restoreRoute: options.restoreRoute !== false });
  state.current = null;
  state.board = null;
  state.editor = null;
  syncProjectHomeSidebarState(state);
  if (options.updateHistory) removeProjectHomeHash();
}

function removeProjectHomeView(state, options = {}) {
  state.renderToken += 1;
  restoreProjectHomeHost(state);
  state.view = null;
  if (options.restoreRoute !== false) {
    restorePreviousRoute(state);
  } else {
    restoreHeaderForProjectHome(state);
    state.restoreTarget = null;
  }
}

function dismissProjectHomeForNativeNavigation(state, navTarget, options = {}) {
  state.ignoreRouteUntil = 0;
  state.renderToken += 1;
  state.current = null;
  state.board = null;
  state.editor = null;
  closeProjectHomeContextMenu(state);
  syncProjectHomeSidebarState(state);
  const root = state.view;
  const navLabel = displayLabelFor(navTarget);
  const navSnapshot = snapshotNavigationTarget(navTarget);
  restoreProjectHomeHost(state, root);
  state.view = null;
  restoreHeaderForProjectHome(state);
  state.restoreTarget = null;
  removeProjectHomeHash();
  if (options.activate) activateNavigationTarget(navTarget);
  for (const delay of [250, 600, 1100, 1800, 2600]) {
    window.setTimeout(() => {
      if (root?.isConnected) root.remove();
      const host = routeContentHost();
      host?.removeAttribute(VIEW_ATTR);
      if (!routeContentHostIsBlank()) return;
      const target = resolveNavigationTarget(navTarget, navSnapshot) ||
        findNavigationTargetByLabel(navLabel);
      activateNavigationTarget(target);
    }, delay);
  }
}

function syncProjectHomeHost(state) {
  if (!state.current || !state.view) return;
  const host = routeContentHost();
  if (!host) return;
  if (state.host !== host || state.view.parentElement !== host) {
    mountProjectHomeRoot(state, host, state.view);
  }
}

function handleRouteChange(state) {
  if (state.disposed) return;
  const routeProject = readProjectHomeFromUrl();
  if (routeProject) {
    const changed = !sameProject(state.current, routeProject);
    state.current = routeProject;
    if (changed) {
      state.board = null;
      state.boardError = "";
    }
    renderProjectHomeView(state);
    if (changed || !state.board) loadProjectHomeBoard(state, routeProject);
    return;
  }
  if (state.current && Date.now() < state.ignoreRouteUntil) return;
  if (state.view) closeProjectHome(state);
}

function pushProjectHomeUrl(path, label) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams();
  params.set(HASH_PATH_KEY, path);
  if (label && label !== path) params.set(HASH_LABEL_KEY, label);
  url.hash = params.toString();
  history.pushState({ codexppProjectHome: true, path, label }, "", url);
}

function replaceProjectHomeUrl(path, label) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  params.set(HASH_PATH_KEY, path);
  if (label && label !== path) params.set(HASH_LABEL_KEY, label);
  url.hash = params.toString();
  history.replaceState({ codexppProjectHome: true, path, label }, "", url);
}

function removeProjectHomeHash() {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (!params.has(HASH_PATH_KEY)) return;
  params.delete(HASH_PATH_KEY);
  params.delete(HASH_LABEL_KEY);
  url.hash = params.toString();
  if (url.hash === "#") url.hash = "";
  history.replaceState({ codexppProjectHome: false }, "", url);
}

function readProjectHomeFromUrl() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const path = params.get(HASH_PATH_KEY);
  if (!path) return null;
  return {
    path,
    label: params.get(HASH_LABEL_KEY) || basenameFor(path, "Project"),
  };
}

function scheduleProjectHomeMounts(state, project, token) {
  for (const delay of [0, 16, 50, 120, 250, 500, 900, 1400]) {
    window.setTimeout(() => {
      if (
        state.disposed ||
        token !== state.renderToken ||
        !sameProject(state.current, project) ||
        !(state.view instanceof HTMLElement)
      ) {
        return;
      }
      tryMountProjectHomeRoot(state);
    }, delay);
  }
}

function tryMountProjectHomeRoot(state) {
  const host = routeContentHost();
  if (!(host instanceof HTMLElement)) return;
  mountProjectHomeRoot(state, host, state.view);
}

function mountProjectHomeRoot(state, host, root) {
  if (!(host instanceof HTMLElement)) return;
  if (host.getAttribute(VIEW_ATTR) !== "host") {
    state.preservedRouteNodes = Array.from(host.childNodes).filter((node) => node !== root);
  }
  host.replaceChildren(root);
  host.setAttribute(VIEW_ATTR, "host");
  state.host = host;
  syncHeaderForProjectHome(state);
}

function restoreProjectHomeHost(state, root = state.view) {
  const host = state.host instanceof HTMLElement && state.host.isConnected
    ? state.host
    : routeContentHost();
  if (root instanceof HTMLElement && root.isConnected) root.remove();
  if (host instanceof HTMLElement) {
    if (state.preservedRouteNodes.length > 0) {
      host.replaceChildren(...state.preservedRouteNodes);
    }
    host.removeAttribute(VIEW_ATTR);
  }
  state.host = null;
  state.preservedRouteNodes = [];
}

function routeContentHost() {
  const main = mainSurface();
  if (!main) return null;
  const header = main.querySelector(":scope > header");
  const host = Array.from(main.children).find((child) => (
    child instanceof HTMLElement &&
    child !== header &&
    child.tagName !== "HEADER"
  ));
  return host instanceof HTMLElement ? host : null;
}

function captureRestoreTarget() {
  const sidebar = mainSidebar();
  if (!sidebar) return null;
  const active = sidebar.querySelector(
    [
      "[data-app-action-sidebar-thread-active='true']",
      "[aria-current='page']",
      "[data-active='true']",
      "[data-state='active']",
    ].join(","),
  );
  const target = active instanceof HTMLElement
    ? active.closest("button,a,[role='button'],div")
    : null;
  if (!(target instanceof HTMLElement)) return null;
  return {
    text: displayLabelFor(target),
    ariaLabel: target.getAttribute("aria-label") || "",
    className: target.className || "",
  };
}

function restorePreviousRoute(state) {
  restoreHeaderForProjectHome(state);
  const target = findRestoreTarget(state.restoreTarget);
  state.restoreTarget = null;
  target?.click();
}

function findRestoreTarget(restoreTarget) {
  if (!restoreTarget) return null;
  const sidebar = mainSidebar();
  if (!sidebar) return null;
  const candidates = Array.from(sidebar.querySelectorAll("button,a,[role='button'],div"))
    .filter((candidate) => candidate instanceof HTMLElement);

  if (restoreTarget.ariaLabel) {
    const byAria = candidates.find((candidate) =>
      candidate.getAttribute("aria-label") === restoreTarget.ariaLabel,
    );
    if (byAria instanceof HTMLElement) return byAria;
  }

  const expected = normalize(restoreTarget.text);
  if (!expected) return null;
  const byText = candidates.filter((candidate) => normalize(displayLabelFor(candidate)) === expected);
  const clickableRow = byText.find((candidate) =>
    /\bgroup\b.*\bcursor-interaction\b/.test(candidate.className || ""),
  );
  if (clickableRow instanceof HTMLElement) return clickableRow;
  const interactive = byText.find((candidate) =>
    candidate.matches("button,a,[role='button']"),
  );
  if (interactive instanceof HTMLElement) return interactive;
  return byText[0] instanceof HTMLElement ? byText[0] : null;
}

function snapshotNavigationTarget(target) {
  if (!(target instanceof HTMLElement)) return null;
  return {
    text: displayLabelFor(target),
    ariaLabel: target.getAttribute("aria-label") || "",
    role: target.getAttribute("role") || "",
    active: target.getAttribute("data-app-action-sidebar-thread-active") || "",
    current: target.getAttribute("aria-current") || "",
    className: String(target.className || ""),
  };
}

function syncHeaderForProjectHome(state) {
  const header = mainSurface()?.querySelector(":scope > header");
  if (!(header instanceof HTMLElement)) return;
  const content = projectHomeHeaderContent(header);
  if (content) hideHeaderNodeForProjectHome(state, content);
  syncProjectHomeHeaderNode(state, header, content);
}

function restoreHeaderForProjectHome(state) {
  state.headerNode?.remove();
  state.headerNode = null;
  state.headerSignature = "";
  const entries = state.hiddenHeaderNodes || [];
  state.hiddenHeaderNodes = [];
  for (const entry of entries) {
    if (!entry.node?.isConnected) continue;
    entry.node.style.display = entry.display;
    entry.node.style.pointerEvents = entry.pointerEvents;
    if (entry.ariaHidden == null) {
      entry.node.removeAttribute("aria-hidden");
    } else {
      entry.node.setAttribute("aria-hidden", entry.ariaHidden);
    }
  }
}

function projectHomeHeaderContent(header) {
  const children = Array.from(header.children)
    .filter((child) => child instanceof HTMLElement);
  return children.find((child) => {
    const className = String(child.className || "");
    return /\bflex-1\b/.test(className) && /\bitems-center\b/.test(className);
  }) || null;
}

function hideHeaderNodeForProjectHome(state, node) {
  if (!(node instanceof HTMLElement)) return;
  if ((state.hiddenHeaderNodes || []).some((entry) => entry.node === node)) return;
  state.hiddenHeaderNodes.push({
    node,
    display: node.style.display || "",
    pointerEvents: node.style.pointerEvents || "",
    ariaHidden: node.getAttribute("aria-hidden"),
  });
  node.style.display = "none";
  node.style.pointerEvents = "none";
  node.setAttribute("aria-hidden", "true");
}

function syncProjectHomeHeaderNode(state, header, hiddenContent) {
  if (!state.current) return;
  let node = state.headerNode;
  if (!(node instanceof HTMLElement) || !node.isConnected) {
    node = document.createElement("div");
    node.setAttribute(HEADER_ATTR, "root");
    state.headerNode = node;
  }
  renderProjectHomeHeader(state, node);
  if (hiddenContent?.parentElement === header) {
    header.insertBefore(node, hiddenContent.nextSibling);
  } else if (node.parentElement !== header) {
    header.append(node);
  }
}

function shouldSyncProjectHomeHeader(state) {
  const header = mainSurface()?.querySelector(":scope > header");
  if (!(header instanceof HTMLElement)) return false;
  if (!(state.headerNode instanceof HTMLElement) || state.headerNode.parentElement !== header) {
    return true;
  }
  const content = projectHomeHeaderContent(header);
  if (!(content instanceof HTMLElement)) return false;
  return content.style.display !== "none" || content.getAttribute("aria-hidden") !== "true";
}

function renderProjectHomeHeader(state, node) {
  const project = state.current || {};
  const signature = [
    project.path || "",
    project.label || "",
    state.viewMode || "board",
    Array.from(state.visibleColumns || []).sort().join(","),
  ].join("\n");
  if (state.headerSignature === signature && node.childNodes.length > 0) return;
  state.headerSignature = signature;
  node.replaceChildren();

  const identity = document.createElement("div");
  identity.setAttribute(HEADER_ATTR, "identity");
  const title = document.createElement("div");
  title.setAttribute("data-header-title", "");
  title.className = "shrink-0";
  title.textContent = "Project Home";
  const separator = document.createElement("span");
  separator.setAttribute("data-header-separator", "");
  separator.setAttribute("aria-hidden", "true");
  const folder = document.createElement("button");
  folder.type = "button";
  folder.setAttribute(HEADER_ATTR, "folder");
  folder.setAttribute("aria-label", `Open ${basenameFor(project.path, project.label || "Project")} folder`);
  folder.title = project.path || project.label || "";
  folder.innerHTML = folderIconSvg();
  const folderName = document.createElement("span");
  folderName.className = "truncate";
  folderName.textContent = basenameFor(project.path, project.label || "Project");
  folder.append(folderName);
  folder.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await state.api.ipc.invoke(IPC_OPEN_PROJECT_FOLDER, { projectPath: project.path });
    } catch (error) {
      state.api.log.error("[project-home] could not open project folder", { error: error?.message || String(error) });
    }
  });
  identity.append(title, separator, folder);

  const controls = document.createElement("div");
  controls.className = "flex shrink-0 items-center gap-2";
  controls.append(
    renderViewModeToggle(state),
    renderColumnMenuButton(state),
  );

  node.append(identity, controls);
}

function renderViewModeToggle(state) {
  const wrap = document.createElement("div");
  wrap.setAttribute(VIEW_ATTR, "toolbar-segment");
  for (const mode of ["board", "list"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `${mode === "board" ? "Board" : "List"} view`);
    button.setAttribute("aria-pressed", String(state.viewMode === mode));
    button.innerHTML = mode === "board" ? boardIconSvg() : listIconSvg();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      state.viewMode = mode;
      state.api.storage?.set?.(VIEW_MODE_STORAGE_KEY, mode);
      renderProjectHomeView(state);
      syncHeaderForProjectHome(state);
    });
    wrap.append(button);
  }
  return wrap;
}

function renderColumnMenuButton(state) {
  return headerIconButton("Visible boards", columnsIconSvg(), (event, button) => {
    const rect = button.getBoundingClientRect();
    openColumnVisibilityMenu(state, rect.left, rect.bottom + 6);
  });
}

function headerIconButton(label, icon, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "flex size-8 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-token-border focus-visible:outline-2";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event, button);
  });
  return button;
}

function openColumnVisibilityMenu(state, x, y) {
  closeProjectHomeContextMenu(state);
  const menu = document.createElement("div");
  menu.setAttribute(CONTEXT_MENU_ATTR, "root");
  menu.setAttribute("role", "menu");

  for (const column of ISSUE_COLUMNS) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute(CONTEXT_MENU_ATTR, "item");
    item.setAttribute("role", "menuitemcheckbox");
    item.setAttribute("aria-checked", String(state.visibleColumns.has(column.id)));
    item.innerHTML = state.visibleColumns.has(column.id) ? checkIconSvg() : emptyIconSvg();
    const text = document.createElement("span");
    text.className = "min-w-0 flex-1 truncate";
    text.textContent = column.title;
    item.append(text);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleVisibleColumn(state, column.id);
      openColumnVisibilityMenu(state, x, y);
    });
    menu.append(item);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  state.contextMenu = menu;
  window.setTimeout(() => installContextMenuDismiss(state, menu), 0);
}

function patchHistoryNavigation() {
  let patch = window[HISTORY_PATCH_KEY];
  if (!patch) {
    const previous = {
      pushState: history.pushState,
      replaceState: history.replaceState,
    };
    const patched = {};
    for (const method of ["pushState", "replaceState"]) {
      patched[method] = function codexppProjectHomeHistoryPatch() {
        const result = previous[method].apply(this, arguments);
        window.dispatchEvent(new Event(ROUTE_EVENT));
        return result;
      };
      history[method] = patched[method];
    }
    patch = { count: 0, previous, patched };
    window[HISTORY_PATCH_KEY] = patch;
  }

  patch.count += 1;
  return () => {
    const active = window[HISTORY_PATCH_KEY];
    if (!active) return;
    active.count -= 1;
    if (active.count > 0) return;
    if (history.pushState === active.patched.pushState) {
      history.pushState = active.previous.pushState;
    }
    if (history.replaceState === active.patched.replaceState) {
      history.replaceState = active.previous.replaceState;
    }
    delete window[HISTORY_PATCH_KEY];
  };
}

function mainSidebar() {
  const aside = document.querySelector(ASIDE_SELECTOR) || document.querySelector("aside");
  return aside instanceof HTMLElement ? aside : null;
}

function mainSurface() {
  const main = document.querySelector("main.main-surface") || document.querySelector("main");
  return main instanceof HTMLElement ? main : null;
}

function isPlainKey(event, key) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return false;
  return String(event.key || "").toLowerCase() === key.toLowerCase();
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) {
    return true;
  }
  return false;
}

function isProjectHomeShortcut(event) {  const key = String(event.key || "").toLowerCase();
  return (
    key === "h" &&
    event.metaKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.repeat
  );
}

function isNewChatShortcut(event) {
  const key = String(event.key || "").toLowerCase();
  return (
    key === "n" &&
    event.metaKey &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.repeat
  );
}

function isSidebarToggleShortcut(event) {
  const key = String(event.key || "").toLowerCase();
  const code = String(event.code || "").toLowerCase();
  return (
    (key === "s" || key === "b" || code === "keys" || code === "keyb") &&
    event.metaKey &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.repeat
  );
}

function isProjectHomeBlockedPanelShortcut(event) {
  if (
    !event.metaKey ||
    event.ctrlKey ||
    event.repeat
  ) {
    return false;
  }

  const key = String(event.key || "").toLowerCase();
  const code = String(event.code || "").toLowerCase();
  const isKey = (value) => key === value || code === `key${value}`;

  return (
    (isKey("j") && !event.shiftKey && !event.altKey) ||
    (isKey("e") && event.shiftKey && !event.altKey) ||
    (isKey("b") && !event.shiftKey && event.altKey)
  );
}

function findNewChatButton() {
  const sidebar = mainSidebar();
  if (!sidebar) return null;
  const candidates = Array.from(sidebar.querySelectorAll("button,a,[role='button']"))
    .filter((candidate) => candidate instanceof HTMLElement && visible(candidate));
  return candidates.find((candidate) => {
    const label = normalize(displayLabelFor(candidate)).replace(/\s*⌘n$/, "");
    const aria = normalize(candidate.getAttribute("aria-label") || "");
    return label === "new chat" || aria === "new chat";
  }) || null;
}

function findSidebarToggleButton() {
  const header = mainSurface()?.querySelector(":scope > header");
  if (!(header instanceof HTMLElement)) return null;
  const buttons = Array.from(header.querySelectorAll("button"))
    .filter((button) => button instanceof HTMLButtonElement && visible(button));
  return buttons.find((button) => {
    const label = normalize(button.getAttribute("aria-label") || button.title || displayLabelFor(button));
    return label === "hide sidebar" || label === "show sidebar";
  }) || null;
}

function currentProjectFromSidebar(state) {
  if (state.current?.path) return state.current;

  const sidebar = mainSidebar();
  if (!sidebar) return null;

  const rows = candidateProjectRows(sidebar);
  const active = sidebar.querySelector(
    [
      "[data-app-action-sidebar-thread-active='true']",
      "[aria-current='page']",
      "[data-active='true']",
      "[data-state='active']",
    ].join(","),
  );
  const activeRow = active instanceof Element
    ? rows.find((row) => row.contains(active))
    : null;
  if (activeRow) return projectDetailsForRow(activeRow);

  const focused = document.activeElement instanceof Element
    ? rows.find((row) => row.contains(document.activeElement))
    : null;
  if (focused) return projectDetailsForRow(focused);

  const hovered = rows.find((row) => row.matches(":hover"));
  if (hovered) return projectDetailsForRow(hovered);

  const expanded = rows.find((row) =>
    row.querySelector("[data-app-action-sidebar-project-collapsed='false']"),
  );
  if (expanded) return projectDetailsForRow(expanded);

  return rows.length === 1 ? projectDetailsForRow(rows[0]) : null;
}

function projectDetailsForRow(row) {
  const path = projectPathFor(row);
  const label = displayLabelFor(row) || basenameFor(path, "Project");
  if (!path && !label) return null;
  return { path: path || label, label: label || basenameFor(path, "Project") };
}

function candidateProjectRows(sidebar) {
  return Array.from(sidebar.querySelectorAll("div[role='listitem'][aria-label]"))
    .filter(isProjectRow)
    .filter((row, index, rows) => rows.indexOf(row) === index);
}

function isProjectRow(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (!visible(node)) return false;
  if (node.getAttribute("role") !== "listitem") return false;
  if (!node.classList.contains("group/cwd")) return false;

  const label = normalizedLabelFor(node);
  if (!label || label.length < 2 || label.length > 260) return false;
  if (EXCLUDED_LABELS.has(label)) return false;

  const action = Array.from(node.querySelectorAll("[role='button'][aria-label]"))
    .find((candidate) => (
      candidate instanceof HTMLElement &&
      labelsMatch(label, normalizedLabelFor(candidate))
    ));
  return action instanceof HTMLElement;
}

function projectActionsButton(row, label) {
  const expected = `project actions for ${normalize(label)}`;
  const button = Array.from(row.querySelectorAll("button[aria-label]"))
    .find((candidate) => (
      candidate instanceof HTMLButtonElement &&
      !candidate.hasAttribute(BUTTON_ATTR) &&
      normalize(candidate.getAttribute("aria-label")) === expected
    ));
  return button instanceof HTMLButtonElement ? button : null;
}

function removeHomeButtonForRow(row) {
  row.querySelectorAll(`[${WRAPPER_ATTR}="true"]`).forEach((node) => node.remove());
  row.querySelectorAll(`[${BUTTON_ATTR}="button"]`).forEach((node) => node.remove());
}

function projectPathFor(row) {
  const candidates = [];
  const collectAttrs = (node) => {
    if (!(node instanceof Element)) return;
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name;
      if (
        name === "title" ||
        name === "aria-label" ||
        name === "aria-description" ||
        name === "data-path" ||
        name === "data-cwd" ||
        name === "data-project-path" ||
        name === "data-folder" ||
        name === "data-directory" ||
        name === "data-app-action-sidebar-project-id" ||
        (name.startsWith("data-") && /path|cwd|dir|folder|location|project-id/i.test(name))
      ) {
        if (attr.value) candidates.push(attr.value);
      }
    }
  };

  const sweep = (root) => {
    if (!root) return;
    collectAttrs(root);
    root.querySelectorAll?.("*").forEach(collectAttrs);
  };
  sweep(row);
  collectProjectAncestorAttrs(row, collectAttrs);

  row.querySelectorAll?.("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    if (/^file:\/\//i.test(href)) {
      try {
        candidates.push(decodeURIComponent(new URL(href).pathname));
      } catch {}
    } else if (/^vscode:\/\/file\//i.test(href)) {
      try {
        candidates.push(decodeURIComponent(href.replace(/^vscode:\/\/file/i, "")));
      } catch {}
    }
  });

  const text = displayLabelFor(row);
  if (text) candidates.push(text);

  for (const value of candidates) {
    const path = normalizePathCandidate(value);
    if (path) return path;
  }
  return "";
}

function collectProjectAncestorAttrs(row, collectAttrs) {
  let node = row.parentElement;
  while (node && node !== document.body) {
    collectAttrs(node);
    if (
      node instanceof HTMLElement &&
      node.hasAttribute("data-app-action-sidebar-project-id")
    ) {
      break;
    }
    if (node.tagName === "ASIDE") break;
    node = node.parentElement;
  }
}

function normalizePathCandidate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (PATH_LIKE_RE.test(trimmed)) return trimmed;
  try {
    const decoded = decodeURIComponent(trimmed);
    if (PATH_LIKE_RE.test(decoded)) return decoded;
  } catch {}
  return "";
}

function displayLabelFor(node) {
  if (!(node instanceof Element)) return "";
  return String(
    node.getAttribute("aria-label") ||
      node.getAttribute("title") ||
      node.textContent ||
      "",
  ).replace(/\s+/g, " ").trim();
}

function normalizedLabelFor(node) {
  return normalize(displayLabelFor(node));
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function labelsMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return basenameFor(left, "") === right || basenameFor(right, "") === left;
}

function basenameFor(path, fallback) {
  const value = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!value) return fallback;
  const match = value.match(/([^\\/]+)$/);
  return match?.[1] || fallback;
}

function visible(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected) return false;
  if (node.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const style = window.getComputedStyle(node);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function closestHomeButton(target) {
  if (!(target instanceof Element)) return null;
  const button = target.closest(`[${BUTTON_ATTR}="button"]`);
  return button instanceof HTMLButtonElement ? button : null;
}

function externalNavigationTarget(state, target) {
  if (!(target instanceof Element)) return null;
  if (closestHomeButton(target)) return null;
  if (target.closest(`[${VIEW_ATTR}="root"]`)) return null;
  const sidebar = mainSidebar();
  if (!sidebar || !sidebar.contains(target)) return null;
  const navTarget = closestClickableSidebarRow(target, sidebar);
  if (!(navTarget instanceof HTMLElement)) return null;
  if (navTarget.closest(`[${WRAPPER_ATTR}="true"]`)) return null;
  return navTarget;
}

function routeContentHostIsBlank() {
  const host = routeContentHost();
  if (!(host instanceof HTMLElement)) return false;
  return host.children.length === 0 && !host.textContent?.trim();
}

function closestClickableSidebarRow(target, sidebar) {
  let node = target instanceof Element ? target : null;
  while (node && node !== sidebar) {
    if (node instanceof HTMLElement) {
      if (node.matches("button,a,[role='button']")) return node;
      const className = String(node.className || "");
      const label = displayLabelFor(node);
      if (
        /\bgroup\b/.test(className) &&
        /\bcursor-interaction\b/.test(className) &&
        label &&
        label.length < 220
      ) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function resolveNavigationTarget(target, snapshot) {
  if (target instanceof HTMLElement && target.isConnected) return target;
  if (!snapshot) return null;
  if (snapshot.ariaLabel) {
    const sidebar = mainSidebar();
    const byAria = sidebar?.querySelector(
      `[aria-label="${cssEscape(snapshot.ariaLabel)}"]`,
    );
    if (byAria instanceof HTMLElement) return byAria;
  }
  return findNavigationTargetByLabel(snapshot.text);
}

function findNavigationTargetByLabel(label) {
  const expected = normalize(label);
  if (!expected) return null;
  const sidebar = mainSidebar();
  if (!sidebar) return null;
  const candidates = Array.from(sidebar.querySelectorAll("button,a,[role='button'],div"))
    .filter((candidate) => candidate instanceof HTMLElement);
  const exact = candidates.filter((candidate) => normalize(displayLabelFor(candidate)) === expected);
  const row = exact.find((candidate) => {
    const className = String(candidate.className || "");
    return /\bgroup\b/.test(className) && /\bcursor-interaction\b/.test(className);
  });
  if (row instanceof HTMLElement) return row;
  const interactive = exact.find((candidate) => candidate.matches("button,a,[role='button']"));
  if (interactive instanceof HTMLElement) return interactive;
  return exact[0] instanceof HTMLElement ? exact[0] : null;
}

function activateNavigationTarget(target) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return;
  target.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.click();
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function stopProjectHomeEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

function clearProjectHomeMarks() {
  document.body.removeAttribute(ACTIVE_ATTR);
  document.querySelectorAll(`[${WRAPPER_ATTR}="true"]`).forEach((wrapper) => wrapper.remove());
  document.querySelectorAll(`[${BUTTON_ATTR}="button"]`).forEach((button) => button.remove());
}

function homeIconSvg() {
  return (
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m3 9 9-7 9 7"></path>' +
    '<path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"></path>' +
    '<path d="M9 21V12h6v9"></path>' +
    "</svg>"
  );
}

function plusIconSvg() {
  return iconSvg('<path d="M5 12h14"></path><path d="M12 5v14"></path>');
}

function caretRightIconSvg() {
  return iconSvg('<path d="M9 6l6 6-6 6"></path>');
}

function copyIconSvg() {
  return iconSvg(
    '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
      '<path d="M5 15V5a2 2 0 0 1 2-2h10"></path>',
  );
}

function refreshIconSvg() {
  return iconSvg(
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>' +
      '<path d="M3 21v-5h5"></path>' +
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>' +
      '<path d="M16 8h5V3"></path>',
  );
}

function ellipsisIconSvg() {
  return iconSvg(
    '<circle cx="12" cy="12" r="1"></circle>' +
      '<circle cx="19" cy="12" r="1"></circle>' +
      '<circle cx="5" cy="12" r="1"></circle>',
  );
}

function editIconSvg() {
  return iconSvg(
    '<path d="M12 20h9"></path>' +
      '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
  );
}

function arrowRightIconSvg() {
  return iconSvg('<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>');
}

function trashIconSvg() {
  return iconSvg(
    '<path d="M3 6h18"></path>' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>',
  );
}

function folderIconSvg() {
  return iconSvg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>');
}

function personIconSvg() {
  return iconSvg(
    '<circle cx="12" cy="8" r="4"></circle>' +
      '<path d="M4 21a8 8 0 0 1 16 0"></path>',
  );
}

function priorityIconSvg() {
  return iconSvg(
    '<path d="M4 20V4"></path>' +
      '<path d="M9 16V8"></path>' +
      '<path d="M14 12V8"></path>',
  );
}

function calendarIconSvg() {
  return iconSvg(
    '<rect x="3" y="5" width="18" height="16" rx="2"></rect>' +
      '<path d="M3 10h18"></path>' +
      '<path d="M8 3v4"></path>' +
      '<path d="M16 3v4"></path>',
  );
}

function tagIconSvg() {
  return iconSvg('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle>');
}

function messageIconSvg() {
  return iconSvg('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>');
}

function chevronRightIconSvg() {
  return iconSvg('<path d="m9 18 6-6-6-6"></path>');
}

function xIconSvg() {
  return iconSvg('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>');
}

function boardIconSvg() {
  return iconSvg(
    '<rect x="3" y="4" width="5" height="16" rx="1"></rect>' +
      '<rect x="9.5" y="4" width="5" height="16" rx="1"></rect>' +
      '<rect x="16" y="4" width="5" height="16" rx="1"></rect>',
  );
}

function listIconSvg() {
  return iconSvg(
    '<path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path>' +
      '<path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>',
  );
}

function columnsIconSvg() {
  return iconSvg(
    '<path d="M3 6h18"></path><path d="M3 12h18"></path><path d="M3 18h18"></path>' +
      '<path d="M8 6v12"></path><path d="M16 6v12"></path>',
  );
}

function checkIconSvg() {
  return iconSvg('<path d="m20 6-11 11-5-5"></path>');
}

function emptyIconSvg() {
  return '<span class="inline-block h-4 w-4 shrink-0"></span>';
}

function iconSvg(paths) {
  return (
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" class="shrink-0">' +
    paths +
    "</svg>"
  );
}
