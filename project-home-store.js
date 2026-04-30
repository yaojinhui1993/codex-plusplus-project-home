"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "In Progress" },
  { id: "in_review", title: "In Review" },
  { id: "done", title: "Done" },
];

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];

const ISSUE_DEFAULTS = Object.freeze({
  title: "Untitled issue",
  description: "",
  status: "backlog",
  priority: "none",
  labels: Object.freeze([]),
  assignee: "",
  dueDate: "",
  comments: Object.freeze([]),
});

function createIssueStore(options = {}) {
  const root = options.root || defaultRoot();
  const issuesDir = path.join(root, "project-home", "issues");
  const issueDefaults = normalizeIssueDefaults(options.issueDefaults);

  return {
    root,
    issuesDir,
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    issueDefaults: cloneIssueDefaults(issueDefaults),

    list(projectPath) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      return publicBoard(db);
    },

    search(projectPath, query = "") {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const board = publicBoard(db);
      const needle = cleanText(query).toLowerCase();
      if (!needle) return { ...board, query: "", issues: board.issues };
      return {
        ...board,
        query: cleanText(query),
        issues: board.issues.filter((issue) => issueMatchesQuery(issue, needle)),
      };
    },

    get(projectPath, issueId) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      return db.issues.find((issue) => issue.id === issueId) || null;
    },

    create(projectPath, input = {}) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const values = issueValues(input, issueDefaults);
      const now = new Date().toISOString();
      const status = values.status;
      const issue = {
        id: nextIssueId(db),
        title: values.title,
        description: values.description,
        status,
        priority: values.priority,
        labels: values.labels,
        assignee: values.assignee,
        dueDate: values.dueDate,
        comments: normalizeComments(values.comments),
        linear: normalizeLinear(input.linear),
        rank: nextRank(db, status),
        createdAt: now,
        updatedAt: now,
      };
      appendComment(issue, input.newComment || input.comment, now, input.newCommentAuthor || input.commentAuthor);
      db.issues.push(issue);
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    update(projectPath, issueId, patch = {}) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const issue = db.issues.find((item) => item.id === issueId);
      if (!issue) return null;

      if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        issue.title = cleanText(patch.title) || issue.title;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "description")) {
        issue.description = cleanText(patch.description);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "priority")) {
        issue.priority = normalizePriority(patch.priority);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "labels")) {
        issue.labels = normalizeLabels(patch.labels);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "assignee")) {
        issue.assignee = cleanText(patch.assignee);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dueDate")) {
        issue.dueDate = normalizeDueDate(patch.dueDate);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "comments")) {
        issue.comments = normalizeComments(patch.comments);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "linear")) {
        issue.linear = normalizeLinear(patch.linear);
      }
      appendComment(issue, patch.newComment || patch.comment, undefined, patch.newCommentAuthor || patch.commentAuthor);
      if (Object.prototype.hasOwnProperty.call(patch, "status")) {
        const status = normalizeStatus(patch.status);
        issue.status = status;
        issue.rank = Number.isFinite(Number(patch.rank)) ? Number(patch.rank) : nextRank(db, status);
      }
      issue.updatedAt = new Date().toISOString();
      normalizeRanks(db);
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    move(projectPath, issueId, status, beforeIssueId = "") {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const issue = db.issues.find((item) => item.id === issueId);
      if (!issue) return null;

      const nextStatus = normalizeStatus(status);
      const targetIssues = db.issues
        .filter((item) => item.id !== issueId && item.status === nextStatus)
        .sort(compareIssueRank);
      let index = targetIssues.length;
      if (beforeIssueId) {
        const found = targetIssues.findIndex((item) => item.id === beforeIssueId);
        if (found >= 0) index = found;
      }
      targetIssues.splice(index, 0, issue);
      issue.status = nextStatus;
      targetIssues.forEach((item, rank) => {
        item.rank = rank;
      });
      issue.updatedAt = new Date().toISOString();
      normalizeRanks(db);
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    delete(projectPath, issueId) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const index = db.issues.findIndex((item) => item.id === issueId);
      if (index < 0) return null;
      const [issue] = db.issues.splice(index, 1);
      normalizeRanks(db);
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    addComment(projectPath, issueId, body, author = "") {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const issue = db.issues.find((item) => item.id === issueId);
      if (!issue) return null;
      appendComment(issue, body, undefined, author);
      issue.updatedAt = new Date().toISOString();
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    setLinear(projectPath, issueId, linear = {}) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      const issue = db.issues.find((item) => item.id === issueId);
      if (!issue) return null;
      issue.linear = normalizeLinear({ ...(issue.linear || {}), ...linear });
      issue.updatedAt = new Date().toISOString();
      writeProjectDb(issuesDir, db);
      return { issue, board: publicBoard(db) };
    },

    updateSettings(projectPath, patch = {}) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      db.settings = normalizeSettings({ ...(db.settings || {}), ...(patch || {}) });
      writeProjectDb(issuesDir, db);
      return publicBoard(db);
    },

    importLinear(projectPath, input = {}) {
      const db = readProjectDb(issuesDir, projectPath, issueDefaults);
      if (Array.isArray(input.columns) && input.columns.length) {
        db.columns = normalizeColumns(input.columns, db.issues);
      }
      const imported = [];
      for (const source of Array.isArray(input.issues) ? input.issues : []) {
        const values = linearIssueValues(source);
        if (!values.linear.id) continue;
        let issue = db.issues.find((item) =>
          item.linear?.id === values.linear.id ||
          (values.linear.identifier && item.linear?.identifier === values.linear.identifier));
        if (!issue) {
          issue = {
            id: nextIssueId(db),
            title: values.title,
            description: values.description,
            status: values.status,
            priority: values.priority,
            labels: values.labels,
            assignee: values.assignee,
            dueDate: values.dueDate,
            comments: [],
            linear: values.linear,
            rank: nextRank(db, values.status),
            createdAt: values.createdAt,
            updatedAt: values.updatedAt,
          };
          db.issues.push(issue);
        } else {
          issue.title = values.title;
          issue.description = values.description;
          issue.status = values.status;
          issue.priority = values.priority;
          issue.labels = values.labels;
          issue.assignee = values.assignee;
          issue.dueDate = values.dueDate;
          issue.linear = normalizeLinear({ ...(issue.linear || {}), ...values.linear });
          issue.updatedAt = values.updatedAt;
        }
        imported.push(issue.id);
      }
      normalizeRanks(db);
      writeProjectDb(issuesDir, db);
      return { imported, board: publicBoard(db) };
    },
  };
}

function defaultRoot() {
  return process.env.CODEX_PLUSPLUS_DATA_DIR ||
    process.env.XDG_DATA_HOME ||
    path.join(os.homedir(), "Library", "Application Support", "codex-plusplus");
}

function readProjectDb(issuesDir, projectPath, issueDefaults = ISSUE_DEFAULTS) {
  const normalizedProjectPath = cleanText(projectPath) || "unknown-project";
  const file = projectFile(issuesDir, normalizedProjectPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeDb(parsed, normalizedProjectPath, file, issueDefaults);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
    return normalizeDb({}, normalizedProjectPath, file, issueDefaults);
  }
}

function writeProjectDb(issuesDir, db) {
  fs.mkdirSync(issuesDir, { recursive: true });
  const payload = {
    projectPath: db.projectPath,
    key: db.key,
    columns: normalizeColumns(db.columns, db.issues),
    issueDefaults: cloneIssueDefaults(db.issueDefaults),
    settings: normalizeSettings(db.settings),
    nextNumber: db.nextNumber,
    issues: db.issues,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(db.file, `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeDb(raw, projectPath, file, issueDefaults = ISSUE_DEFAULTS) {
  const defaults = normalizeIssueDefaults(raw.issueDefaults || issueDefaults);
  const issues = Array.isArray(raw.issues) ? raw.issues.map(normalizeIssue).filter(Boolean) : [];
  const db = {
    projectPath,
    key: projectKey(projectPath),
    file,
    columns: normalizeColumns(raw.columns, issues),
    issueDefaults: defaults,
    settings: normalizeSettings(raw.settings),
    nextNumber: Math.max(Number(raw.nextNumber) || 1, maxIssueNumber(issues) + 1),
    issues,
  };
  normalizeRanks(db);
  return db;
}

function normalizeIssue(issue) {
  if (!issue || typeof issue !== "object") return null;
  const now = new Date().toISOString();
  const id = cleanText(issue.id) || "";
  return {
    id,
    title: cleanText(issue.title) || id || "Untitled issue",
    description: cleanText(issue.description),
    status: normalizeStatus(issue.status),
    priority: normalizePriority(issue.priority),
    labels: normalizeLabels(issue.labels),
    assignee: cleanText(issue.assignee),
    dueDate: normalizeDueDate(issue.dueDate),
    comments: normalizeComments(issue.comments),
    linear: normalizeLinear(issue.linear),
    rank: Number.isFinite(Number(issue.rank)) ? Number(issue.rank) : 0,
    createdAt: cleanText(issue.createdAt) || now,
    updatedAt: cleanText(issue.updatedAt) || now,
  };
}

function publicBoard(db) {
  return {
    projectPath: db.projectPath,
    key: db.key,
    columns: normalizeColumns(db.columns, db.issues),
    issueDefaults: cloneIssueDefaults(db.issueDefaults),
    settings: normalizeSettings(db.settings),
    issues: [...db.issues].sort(compareIssueRank),
  };
}

function projectFile(issuesDir, projectPath) {
  return path.join(issuesDir, `${projectKey(projectPath)}.json`);
}

function projectKey(projectPath) {
  return crypto.createHash("sha256").update(String(projectPath || "")).digest("hex").slice(0, 24);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value) {
  const raw = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return raw || "backlog";
}

function normalizeColumns(columns, issues = []) {
  const seen = new Set();
  const result = [];
  const hasExplicitColumns = Array.isArray(columns) && columns.length > 0;
  const add = (column) => {
    if (!column || typeof column !== "object") return;
    const id = normalizeStatus(column.id || column.status || column.name || column.title);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const title = cleanText(column.title || column.name) || columnTitleFromId(id);
    const normalized = {
      id,
      title,
    };
    const linearStateId = cleanText(column.linearStateId || column.stateId);
    if (linearStateId) normalized.linearStateId = linearStateId;
    const linearType = cleanText(column.linearType || column.type);
    if (linearType) normalized.linearType = linearType;
    result.push(normalized);
  };
  (hasExplicitColumns ? columns : DEFAULT_COLUMNS).forEach(add);
  if (!hasExplicitColumns) {
    for (const issue of Array.isArray(issues) ? issues : []) {
      const status = normalizeStatus(issue?.status);
      if (status && !seen.has(status)) add({ id: status, title: columnTitleFromId(status) });
    }
  }
  return result.length ? result : DEFAULT_COLUMNS.map((column) => ({ ...column }));
}

function columnTitleFromId(id) {
  return cleanText(id).replace(/^linear_/, "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) || "Backlog";
}

function normalizePriority(value) {
  const raw = cleanText(value).toLowerCase();
  return PRIORITIES.includes(raw) ? raw : "none";
}

function normalizeLabels(labels) {
  if (Array.isArray(labels)) return labels.map(cleanText).filter(Boolean).slice(0, 12);
  const text = cleanText(labels);
  return text ? text.split(",").map(cleanText).filter(Boolean).slice(0, 12) : [];
}

function normalizeIssueDefaults(defaults = {}) {
  return issueValues(defaults, ISSUE_DEFAULTS);
}

function issueValues(input = {}, defaults = ISSUE_DEFAULTS) {
  const source = input && typeof input === "object" ? input : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : ISSUE_DEFAULTS;
  const value = (name) => Object.prototype.hasOwnProperty.call(source, name) ? source[name] : fallback[name];
  return {
    title: cleanText(value("title")) || ISSUE_DEFAULTS.title,
    description: cleanText(value("description")),
    status: normalizeStatus(value("status")),
    priority: normalizePriority(value("priority")),
    labels: normalizeLabels(value("labels")),
    assignee: cleanText(value("assignee")),
    dueDate: normalizeDueDate(value("dueDate") || value("deadline")),
    comments: normalizeComments(value("comments")),
  };
}

function cloneIssueDefaults(defaults) {
  return {
    title: defaults.title,
    description: defaults.description,
    status: defaults.status,
    priority: defaults.priority,
    labels: [...defaults.labels],
    assignee: defaults.assignee,
    dueDate: defaults.dueDate,
    comments: normalizeComments(defaults.comments),
  };
}

function normalizeDueDate(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return "";
  const time = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isNaN(time) ? "" : match[1];
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment, index) => {
      if (typeof comment === "string") {
        const body = cleanText(comment);
        return body ? {
          id: `C-${index + 1}`,
          body,
          author: "",
          createdAt: new Date().toISOString(),
        } : null;
      }
      if (!comment || typeof comment !== "object") return null;
      const body = cleanText(comment.body || comment.text || comment.comment);
      if (!body) return null;
      return {
        id: cleanText(comment.id) || `C-${index + 1}`,
        body,
        author: cleanText(comment.author),
        createdAt: cleanText(comment.createdAt) || new Date().toISOString(),
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeLinear(linear) {
  if (!linear || typeof linear !== "object") return {};
  const result = {
    id: cleanText(linear.id),
    identifier: cleanText(linear.identifier),
    url: cleanText(linear.url),
    stateId: cleanText(linear.stateId),
    stateName: cleanText(linear.stateName),
    syncedAt: cleanText(linear.syncedAt),
    lastError: cleanText(linear.lastError),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value));
}

function linearIssueValues(source) {
  const state = source.state || {};
  const status = linearStatusId(state);
  const updatedAt = cleanText(source.updatedAt) || new Date().toISOString();
  return {
    title: cleanText(source.title) || cleanText(source.identifier) || "Untitled issue",
    description: cleanText(source.description),
    status,
    priority: normalizeLinearPriority(source.priority),
    labels: normalizeLabels(source.labels),
    assignee: cleanText(source.assignee),
    dueDate: normalizeDueDate(source.dueDate),
    createdAt: cleanText(source.createdAt) || updatedAt,
    updatedAt,
    linear: normalizeLinear({
      id: source.id,
      identifier: source.identifier,
      url: source.url,
      stateId: state.id,
      stateName: state.name,
      syncedAt: new Date().toISOString(),
      lastError: "",
    }),
  };
}

function normalizeLinearPriority(value) {
  const number = Number(value);
  if (number === 1) return "urgent";
  if (number === 2) return "high";
  if (number === 3) return "medium";
  if (number === 4) return "low";
  return normalizePriority(value);
}

function linearStatusId(state) {
  const stateId = cleanText(state?.id);
  if (stateId) return `linear_${stateId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
  return normalizeStatus(state?.name);
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    linear: normalizeLinearSettings(source.linear),
  };
}

function normalizeLinearSettings(linear) {
  if (!linear || typeof linear !== "object") {
    return { enabled: false, teamId: "", apiKey: "", apiUrl: "", defaultSyncMode: "dryRun", assignedToMeOnly: false };
  }
  const defaultSyncMode = cleanText(linear.defaultSyncMode) === "write" ? "write" : "dryRun";
  const apiKey = cleanLinearApiKey(linear.apiKey);
  return {
    enabled: Boolean(linear.enabled),
    teamId: cleanText(linear.teamId),
    apiKey,
    apiUrl: cleanText(linear.apiUrl),
    defaultSyncMode,
    assignedToMeOnly: Boolean(linear.assignedToMeOnly),
  };
}

function cleanLinearApiKey(value) {
  const text = cleanText(value);
  if (/^Error rendering page:/i.test(text)) return "";
  return text;
}

function issueMatchesQuery(issue, needle) {
  if (!needle) return true;
  const haystack = [
    issue.id,
    issue.title,
    issue.description,
    issue.status,
    columnTitle(issue.status),
    issue.priority,
    issue.assignee,
    issue.dueDate,
    ...(Array.isArray(issue.labels) ? issue.labels : []),
    ...(Array.isArray(issue.comments) ? issue.comments.flatMap((comment) => [
      comment.body,
      comment.author,
    ]) : []),
    issue.linear?.identifier,
    issue.linear?.url,
  ].map(cleanText).join(" ").toLowerCase();
  return haystack.includes(needle);
}

function columnTitle(status) {
  const column = DEFAULT_COLUMNS.find((item) => item.id === status);
  return column?.title || status || "";
}

function appendComment(issue, body, createdAt = new Date().toISOString(), author = "") {
  const text = cleanText(body);
  if (!text) return;
  const comments = normalizeComments(issue.comments);
  comments.push({
    id: `C-${comments.length + 1}`,
    body: text,
    author: cleanText(author),
    createdAt,
  });
  issue.comments = comments;
}

function nextIssueId(db) {
  const number = db.nextNumber || 1;
  db.nextNumber = number + 1;
  return `${projectPrefix(db.projectPath)}-${number}`;
}

function maxIssueNumber(issues) {
  return issues.reduce((max, issue) => {
    const match = String(issue.id || "").match(/^[A-Z]+-(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function projectPrefix(projectPath) {
  const base = path.basename(String(projectPath || "")).replace(/[^A-Za-z0-9]/g, "");
  const slug = base.slice(0, 3).toUpperCase();
  return slug.length >= 2 ? slug : "PH";
}

function nextRank(db, status) {
  return db.issues
    .filter((issue) => issue.status === status)
    .reduce((max, issue) => Math.max(max, Number(issue.rank) || 0), -1) + 1;
}

function normalizeRanks(db) {
  const columns = normalizeColumns(db.columns, db.issues);
  for (const column of columns) {
    db.issues
      .filter((issue) => issue.status === column.id)
      .sort(compareIssueRank)
      .forEach((issue, index) => {
        issue.rank = index;
      });
  }
}

function compareIssueRank(a, b) {
  if (a.status !== b.status) return a.status.localeCompare(b.status);
  const rankDiff = (Number(a.rank) || 0) - (Number(b.rank) || 0);
  if (rankDiff !== 0) return rankDiff;
  return String(a.id).localeCompare(String(b.id));
}

module.exports = {
  DEFAULT_COLUMNS,
  ISSUE_DEFAULTS,
  PRIORITIES,
  createIssueStore,
  projectKey,
  projectPrefix,
};
