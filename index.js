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
    if (api.process && api.process !== "renderer") return;
    startRenderer(this, api);
  },

  stop() {
    const state = this._state;
    if (!state) return;
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
    removeProjectHomeView(state);
    clearProjectHomeMarks();
    state.style?.remove();
    this._state = null;
  },
};

function startRenderer(self, api) {
  const state = {
    api,
    disposed: false,
    style: installStyle(),
    observer: null,
    current: null,
    view: null,
    host: null,
    preservedRouteNodes: [],
    restoreTarget: null,
    hiddenHeaderNodes: [],
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

    if (event.key === "Escape" && state.view) {
      event.preventDefault();
      event.stopPropagation();
      closeProjectHome(state, { updateHistory: true });
      return;
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
    if (state.current && state.view) syncHeaderForProjectHome(state);
  });
  state.observer.observe(document.body, { childList: true, subtree: true });
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
      overflow: auto;
      scrollbar-gutter: stable;
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
  syncProjectHomeSidebarState(state);
  pushProjectHomeUrl(path, label);
  renderProjectHomeView(state);
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

  const headingBlock = document.createElement("div");
  headingBlock.className =
    "mx-auto flex w-full max-w-[var(--thread-content-max-width)] flex-col gap-1 px-panel pt-panel pb-6";

  const heading = document.createElement("div");
  heading.className = "heading-xl font-normal text-token-foreground";
  heading.textContent = "Project Home";

  const subtitle = document.createElement("div");
  subtitle.className = "text-lg font-normal text-token-description-foreground";
  subtitle.textContent = project.label || basenameFor(project.path, "Project");

  const pathLine = document.createElement("div");
  pathLine.setAttribute(VIEW_ATTR, "path");
  pathLine.className = "mt-2 text-token-description-foreground";
  pathLine.textContent = project.path;

  headingBlock.append(heading, subtitle, pathLine);

  const contentBlock = document.createElement("div");
  contentBlock.className =
    "mx-auto flex min-h-0 w-full max-w-[var(--thread-content-max-width)] flex-1 flex-col gap-4 px-panel pb-panel";

  const sectionWrap = document.createElement("div");
  sectionWrap.className =
    "flex min-h-0 w-full flex-1 flex-col gap-8 [--sectioned-page-leading-inset:0.5rem] mt-2";

  const section = document.createElement("section");
  section.className = "flex flex-col gap-4";

  const sectionHeader = document.createElement("div");
  sectionHeader.className =
    "flex items-center justify-between gap-3 border-b border-token-border-light pr-0.5 pb-2";

  const sectionTitle = document.createElement("div");
  sectionTitle.className = "text-lg leading-6 text-token-foreground";
  sectionTitle.textContent = "Overview";
  sectionHeader.append(sectionTitle);

  const grid = document.createElement("div");
  grid.setAttribute(VIEW_ATTR, "template-grid");

  const helloCard = document.createElement("button");
  helloCard.type = "button";
  helloCard.className =
    "group flex w-full flex-col items-start gap-2 rounded-4xl border border-token-border/50 bg-token-input-background/70 px-3 py-3 text-left text-base transition-colors hover:border-token-border hover:bg-token-input-background focus-visible:outline-token-border focus-visible:outline-2 focus-visible:outline-offset-2";
  helloCard.addEventListener("click", (event) => event.preventDefault());

  const helloTitle = document.createElement("div");
  helloTitle.className = "text-base text-token-foreground";
  helloTitle.textContent = "Hello world";

  const helloPath = document.createElement("div");
  helloPath.setAttribute(VIEW_ATTR, "card-path");
  helloPath.className = "text-token-description-foreground";
  helloPath.textContent = project.path;

  helloCard.append(helloTitle, helloPath);
  grid.append(helloCard);
  section.append(sectionHeader, grid);
  sectionWrap.append(section);
  contentBlock.append(sectionWrap);
  scroll.append(headingBlock, contentBlock);
  root.append(scroll);
  scheduleProjectHomeMounts(state, project, token);
}

function sameProject(left, right) {
  return !!left && !!right && left.path === right.path && left.label === right.label;
}

function closeProjectHome(state, options = {}) {
  state.ignoreRouteUntil = 0;
  removeProjectHomeView(state, { restoreRoute: options.restoreRoute !== false });
  state.current = null;
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
    state.current = routeProject;
    renderProjectHomeView(state);
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
}

function restoreHeaderForProjectHome(state) {
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

function isProjectHomeShortcut(event) {
  const key = String(event.key || "").toLowerCase();
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
