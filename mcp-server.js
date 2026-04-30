#!/usr/bin/env node
"use strict";

const { createIssueStore, DEFAULT_COLUMNS, ISSUE_DEFAULTS, PRIORITIES } = require("./project-home-store");

const store = createIssueStore();
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  drainInput();
});

function drainInput() {
  while (input.length > 0) {
    if (/^Content-Length:/i.test(input)) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = input.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        input = "";
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (input.length < bodyStart + length) return;
      handleMessage(input.slice(bodyStart, bodyStart + length));
      input = input.slice(bodyStart + length);
      continue;
    }

    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line) handleMessage(line);
  }
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || message.id == null) return;

  Promise.resolve()
    .then(() => dispatch(message))
    .then((result) => respond({ jsonrpc: "2.0", id: message.id, result }))
    .catch((error) => respond({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    }));
}

function dispatch(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        serverInfo: { name: "project-home", version: "1.0.0" },
        capabilities: { tools: {} },
      };
    case "tools/list":
      return { tools: tools() };
    case "tools/call":
      return callTool(message.params?.name, message.params?.arguments || {});
    case "ping":
      return {};
    default:
      throw new Error(`Unsupported method: ${message.method}`);
  }
}

function callTool(name, args) {
  if (name === "project_home_help") {
    return content(helpText(args.tool));
  }
  const projectPath = requireString(args.projectPath, "projectPath");
  switch (name) {
    case "project_home_list_issues":
      return content(store.list(projectPath));
    case "project_home_search_issues":
      return content(store.search(projectPath, requireString(args.query, "query")));
    case "project_home_get_issue":
      return content(store.get(projectPath, requireString(args.issueId, "issueId")));
    case "project_home_create_issue":
      return content(store.create(projectPath, args));
    case "project_home_update_issue":
      return content(store.update(projectPath, requireString(args.issueId, "issueId"), args));
    case "project_home_move_issue":
      return content(store.move(
        projectPath,
        requireString(args.issueId, "issueId"),
        requireString(args.status, "status"),
        args.beforeIssueId || "",
      ));
    case "project_home_add_comment":
      return content(store.addComment(
        projectPath,
        requireString(args.issueId, "issueId"),
        requireString(args.body || args.comment, "body"),
        args.author || "",
      ));
    case "project_home_delete_issue":
      return content(store.delete(projectPath, requireString(args.issueId, "issueId")));
    case "project_home_linear_sync":
      return syncLinear(projectPath, args).then(content);
    case "project_home_columns":
      return content({
        columns: store.list(projectPath).columns,
        priorities: PRIORITIES,
        issueDefaults: store.issueDefaults || ISSUE_DEFAULTS,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function tools() {
  const projectPath = {
    type: "string",
    description: "Absolute path for the Codex project. Each project path has its own issue DB.",
  };
  const issueId = { type: "string", description: "Issue id, for example TWE-1 (prefix derived from the project folder name)." };
  const status = { type: "string", description: "Kanban column id. When Linear sync is enabled, this can be a Linear workflow state column id." };
  const priority = { type: "string", enum: PRIORITIES };
  const labels = {
    oneOf: [
      { type: "array", items: { type: "string" } },
      { type: "string" },
    ],
    default: ISSUE_DEFAULTS.labels,
    description: "Issue labels as an array or comma-separated string.",
  };
  const dueDate = {
    type: "string",
    description: "Deadline in YYYY-MM-DD format. Empty string clears the deadline.",
  };
  const comments = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        createdAt: { type: "string" },
      },
      required: ["body"],
    },
  };
  return [
    {
      name: "project_home_help",
      description: "Show usage guidance for the project-home MCP. Optionally pass `tool` for details on a specific tool.",
      inputSchema: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description: "Optional tool name (with or without the `project_home_` prefix) to get focused help.",
          },
        },
      },
    },
    {
      name: "project_home_linear_sync",
      description: "Push Project Home issues to Linear and persist Linear ids on local issues.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath,
          issueId: { type: "string", description: "Optional single issue id to sync. Omit to sync all issues." },
          teamId: { type: "string", description: "Linear team UUID. Defaults to the saved Project Home setting, LINEAR_TEAM_ID, or the first team available to the API key." },
          apiKey: { type: "string", description: "Linear API key. Defaults to LINEAR_API_KEY or LINEAR_ACCESS_TOKEN." },
          dryRun: { type: "boolean", default: false, description: "When true, report planned creates/updates without writing Linear or local metadata." },
          assignedToMeOnly: { type: "boolean", description: "When true, sync only issues whose Project Home assignee matches the Linear API viewer." },
          pull: { type: "boolean", description: "When true, pull Linear workflow states and existing Linear issues into Project Home before pushing local changes." },
        },
        required: ["projectPath"],
      },
    },
    {
      name: "project_home_columns",
      description: "List Project Home issue columns and priority values.",
      inputSchema: { type: "object", properties: { projectPath }, required: ["projectPath"] },
    },
    {
      name: "project_home_list_issues",
      description: "List all issues for a project.",
      inputSchema: { type: "object", properties: { projectPath }, required: ["projectPath"] },
    },
    {
      name: "project_home_search_issues",
      description: "Search issues by id, title, description, status, priority, label, assignee, due date, comment, or Linear metadata.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath,
          query: { type: "string", description: "Case-insensitive text to search for across issue fields." },
        },
        required: ["projectPath", "query"],
      },
    },
    {
      name: "project_home_get_issue",
      description: "Get one issue by id.",
      inputSchema: { type: "object", properties: { projectPath, issueId }, required: ["projectPath", "issueId"] },
    },
    {
      name: "project_home_create_issue",
      description: "Create a Linear-style issue in the project board.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath,
          title: { type: "string", default: ISSUE_DEFAULTS.title },
          description: { type: "string", default: ISSUE_DEFAULTS.description },
          status: { ...status, default: ISSUE_DEFAULTS.status },
          priority: { ...priority, default: ISSUE_DEFAULTS.priority },
          labels,
          assignee: { type: "string", default: ISSUE_DEFAULTS.assignee },
          dueDate: { ...dueDate, default: ISSUE_DEFAULTS.dueDate },
          comments,
          newComment: { type: "string", description: "Optional initial comment body." },
          newCommentAuthor: { type: "string", description: "Optional author for newComment (e.g. \"Codex\")." },
        },
        required: ["projectPath"],
      },
    },
    {
      name: "project_home_update_issue",
      description: "Update issue details.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath,
          issueId,
          title: { type: "string" },
          description: { type: "string" },
          status,
          priority,
          labels,
          assignee: { type: "string" },
          dueDate,
          comments,
          newComment: { type: "string", description: "Optional comment body to append." },
          newCommentAuthor: { type: "string", description: "Optional author for newComment (e.g. \"Codex\")." },
        },
        required: ["projectPath", "issueId"],
      },
    },
    {
      name: "project_home_add_comment",
      description: "Append a comment to an issue.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath,
          issueId,
          body: { type: "string", description: "Comment body." },
          author: { type: "string", description: "Optional comment author (e.g. \"Codex\")." },
        },
        required: ["projectPath", "issueId", "body"],
      },
    },
    {
      name: "project_home_move_issue",
      description: "Move an issue to another column and optionally place it before another issue.",
      inputSchema: {
        type: "object",
        properties: { projectPath, issueId, status, beforeIssueId: { type: "string" } },
        required: ["projectPath", "issueId", "status"],
      },
    },
    {
      name: "project_home_delete_issue",
      description: "Delete an issue from a project board.",
      inputSchema: { type: "object", properties: { projectPath, issueId }, required: ["projectPath", "issueId"] },
    },
  ];
}

function content(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function helpText(toolName) {
  const sections = {
    overview: [
      "project-home MCP — per-project Linear-style issue board.",
      "",
      "All tools (except `project_home_help`) require `projectPath` (absolute path).",
      "Issue ids are auto-generated as `<PREFIX>-<n>` where PREFIX is the first 2-3 alphanumeric chars of the project folder name (e.g. issues under `.../tweaks/` become `TWE-1`).",
      "",
      "Statuses (column ids): backlog, todo, in_progress, in_review, done.",
      "Priorities: urgent, high, medium, low, none.",
      "",
      "Conventions:",
      "- When acting as an automated agent, pass `author: \"Codex\"` to comment-related tools so notes are attributed.",
      "- Move an issue to `in_progress` when you start work, `in_review` when ready for review, `done` when finished.",
      "",
      "Tools:",
      "- project_home_help          show this help (optional `tool` arg for focused help).",
      "- project_home_columns       list column ids, priorities, and issue defaults.",
      "- project_home_list_issues   list every issue in the project.",
      "- project_home_search_issues search issues across common fields.",
      "- project_home_get_issue     fetch a single issue by id.",
      "- project_home_create_issue  create a new issue.",
      "- project_home_update_issue  patch any issue field, optionally append a comment.",
      "- project_home_add_comment   append a single comment.",
      "- project_home_move_issue    change an issue's status (and optional ordering).",
      "- project_home_delete_issue  remove an issue.",
      "- project_home_linear_sync   push local Project Home issues to Linear.",
      "",
      "Call `project_home_help` with `tool: \"<name>\"` for argument-level details.",
    ].join("\n"),

    project_home_help: [
      "project_home_help",
      "Args:",
      "  tool (optional, string) — focus on one tool. Accepts \"create_issue\" or \"project_home_create_issue\".",
      "Returns: this guidance text.",
    ].join("\n"),

    project_home_columns: [
      "project_home_columns",
      "Args:",
      "  projectPath (required) — absolute project path.",
      "Returns: { columns, priorities, issueDefaults }.",
      "Use this if you're unsure which status/priority strings are valid.",
    ].join("\n"),

    project_home_list_issues: [
      "project_home_list_issues",
      "Args:",
      "  projectPath (required).",
      "Returns: { projectPath, key, columns, issueDefaults, issues[] } sorted by status then rank.",
    ].join("\n"),

    project_home_search_issues: [
      "project_home_search_issues",
      "Args:",
      "  projectPath (required).",
      "  query       (required) — case-insensitive text matched against id, title, description, status, priority, labels, assignee, due date, comments, and Linear metadata.",
      "Returns: { projectPath, key, columns, issueDefaults, query, issues[] } with matching issues sorted by status then rank.",
      "Use this before list_issues when you only need issues matching a term.",
    ].join("\n"),

    project_home_get_issue: [
      "project_home_get_issue",
      "Args:",
      "  projectPath (required).",
      "  issueId    (required) — e.g. \"TWE-1\".",
      "Returns: the issue object, or null if missing.",
    ].join("\n"),

    project_home_create_issue: [
      "project_home_create_issue",
      "Args:",
      "  projectPath       (required).",
      "  title             (string)   — defaults to \"Untitled issue\".",
      "  description       (string).",
      "  status            (enum, default \"backlog\").",
      "  priority          (enum, default \"none\").",
      "  labels            (array of strings or comma-separated string, max 12).",
      "  assignee          (string).",
      "  dueDate           (YYYY-MM-DD, empty string clears).",
      "  newComment        (string)   — optional initial comment body.",
      "  newCommentAuthor  (string)   — optional author for newComment, e.g. \"Codex\".",
      "Returns: { issue, board }.",
    ].join("\n"),

    project_home_update_issue: [
      "project_home_update_issue",
      "Args (only patched fields are required besides projectPath/issueId):",
      "  projectPath       (required).",
      "  issueId           (required).",
      "  title, description, status, priority, labels, assignee, dueDate, comments — any subset.",
      "  newComment        (string)   — append a comment in the same call.",
      "  newCommentAuthor  (string)   — author for newComment.",
      "Returns: { issue, board }, or null if the issue does not exist.",
    ].join("\n"),

    project_home_add_comment: [
      "project_home_add_comment",
      "Args:",
      "  projectPath (required).",
      "  issueId     (required).",
      "  body        (required) — comment body.",
      "  author      (string)   — optional, e.g. \"Codex\".",
      "Returns: { issue, board }.",
    ].join("\n"),

    project_home_move_issue: [
      "project_home_move_issue",
      "Args:",
      "  projectPath   (required).",
      "  issueId       (required).",
      "  status        (required, enum) — destination column id.",
      "  beforeIssueId (optional)       — place this issue immediately before that one in the new column.",
      "Returns: { issue, board }.",
    ].join("\n"),

    project_home_delete_issue: [
      "project_home_delete_issue",
      "Args:",
      "  projectPath (required).",
      "  issueId     (required).",
      "Returns: { issue, board }, or null if the issue does not exist.",
    ].join("\n"),

    project_home_linear_sync: [
      "project_home_linear_sync",
      "Args:",
      "  projectPath (required).",
      "  issueId     (optional) — sync only one local issue.",
      "  teamId      (optional) — Linear team UUID; defaults to saved settings, LINEAR_TEAM_ID, or the first team available to the API key.",
      "  apiKey      (optional) — Linear API key; defaults to LINEAR_API_KEY or LINEAR_ACCESS_TOKEN.",
      "  dryRun      (boolean)  — report planned creates/updates without writing.",
      "  pull        (boolean)  — pull Linear workflow states and existing team issues before pushing.",
      "Behavior:",
      "  Creates Linear issues for local issues without linear.id.",
      "  Updates Linear issues for local issues with linear.id.",
      "  Persists { id, identifier, url, syncedAt } under issue.linear after successful writes.",
      "  Maps Project Home statuses to Linear workflow states by normalized name when possible.",
      "  Maps priorities urgent/high/medium/low/none to Linear priority values 1/2/3/4/0.",
      "Returns: { dryRun, teamId, synced[], failed[], board }.",
    ].join("\n"),
  };

  if (!toolName) return sections.overview;
  const key = String(toolName).trim().replace(/^project_home_/, "");
  const fullKey = `project_home_${key}`;
  if (sections[fullKey]) return sections[fullKey];
  if (sections[key]) return sections[key];
  return `Unknown tool "${toolName}". Call project_home_help with no arguments to list available tools.`;
}

async function syncLinear(projectPath, args = {}) {
  const board = store.list(projectPath);
  const linearSettings = board.settings?.linear || {};
  const apiKey = requireLinearApiKey(args, linearSettings);
  const dryRun = Boolean(args.dryRun);
  const issues = board.issues.filter((issue) => !args.issueId || issue.id === args.issueId);
  if (args.issueId && issues.length === 0) throw new Error(`Issue not found: ${args.issueId}`);

  const client = createLinearClient(apiKey, args.apiUrl || linearSettings.apiUrl || process.env.LINEAR_API_URL);
  const teamId = await resolveLinearTeamId(client, args.teamId || linearSettings.teamId || process.env.LINEAR_TEAM_ID);
  const states = await client.teamStates(teamId);
  let boardAfterPull = board;
  let pulled = { imported: [], columns: [] };
  if (args.pull && !dryRun) {
    const linearIssues = await client.issues(teamId);
    const imported = store.importLinear(projectPath, {
      columns: linearColumnsFromStates(states),
      issues: linearIssues.map(linearIssueFromApi),
    });
    boardAfterPull = imported.board;
    pulled = { imported: imported.imported, columns: imported.board.columns };
  }
  const assignedToMeOnly = Boolean(args.assignedToMeOnly || linearSettings.assignedToMeOnly);
  const viewer = assignedToMeOnly ? await client.viewer() : null;
  const skipped = [];
  const synced = [];
  const failed = [];
  const syncBoard = args.pull && !dryRun ? boardAfterPull : board;
  const syncIssues = syncBoard.issues.filter((issue) => !args.issueId || issue.id === args.issueId);

  for (const issue of syncIssues) {
    const planned = {
      issueId: issue.id,
      action: issue.linear?.id ? "update" : "create",
      linearId: issue.linear?.id || "",
      title: issue.title,
    };
    if (assignedToMeOnly && !issueAssignedToViewer(issue, viewer)) {
      skipped.push({ ...planned, reason: "not_assigned_to_viewer", assignee: issue.assignee || "" });
      continue;
    }
    if (dryRun) {
      synced.push(planned);
      continue;
    }
    try {
      const input = linearIssueInput(issue, teamId, states, syncBoard.columns);
      const linearIssue = issue.linear?.id
        ? await client.updateIssue(issue.linear.id, input)
        : await client.createIssue(input);
      const syncedAt = new Date().toISOString();
      const patch = {
        id: linearIssue.id,
        identifier: linearIssue.identifier,
        url: linearIssue.url,
        syncedAt,
        lastError: "",
      };
      store.setLinear(projectPath, issue.id, patch);
      synced.push({ ...planned, ...patch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setLinear(projectPath, issue.id, {
        ...(issue.linear || {}),
        lastError: message,
        syncedAt: new Date().toISOString(),
      });
      failed.push({ ...planned, error: message });
    }
  }

  return { dryRun, teamId, assignedToMeOnly, pulled, skipped, synced, failed, board: store.list(projectPath) };
}

function requireLinearApiKey(args = {}, settings = {}) {
  const key = String(args.apiKey || settings.apiKey || process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN || "").trim();
  if (!key) throw new Error("apiKey is required (or set LINEAR_API_KEY / LINEAR_ACCESS_TOKEN)");
  return key;
}

async function resolveLinearTeamId(client, preferredTeamId) {
  const teamId = String(preferredTeamId || "").trim();
  if (teamId) return teamId;
  const teams = await client.teams();
  const first = teams[0];
  if (!first?.id) {
    throw new Error("teamId is required because no Linear teams were available to the API key");
  }
  return first.id;
}

function linearIssueInput(issue, teamId, states, columns = []) {
  const input = {
    teamId,
    title: String(issue.title || "Untitled issue"),
    description: linearDescription(issue),
    priority: linearPriority(issue.priority),
  };
  const stateId = linearStateId(issue.status, states, columns);
  if (stateId) input.stateId = stateId;
  if (issue.dueDate) input.dueDate = issue.dueDate;
  return input;
}

function linearDescription(issue) {
  const parts = [];
  if (issue.description) parts.push(issue.description);
  parts.push(`\nSynced from Project Home issue ${issue.id}.`);
  if (Array.isArray(issue.labels) && issue.labels.length) {
    parts.push(`Labels: ${issue.labels.join(", ")}`);
  }
  if (issue.assignee) parts.push(`Assignee: ${issue.assignee}`);
  if (Array.isArray(issue.comments) && issue.comments.length) {
    parts.push("\nProject Home comments:");
    for (const comment of issue.comments.slice(-10)) {
      const author = comment.author ? `${comment.author}: ` : "";
      parts.push(`- ${author}${comment.body}`);
    }
  }
  return parts.join("\n");
}

function linearPriority(priority) {
  return ({ urgent: 1, high: 2, medium: 3, low: 4, none: 0 })[String(priority || "none").toLowerCase()] ?? 0;
}

function linearStateId(status, states, columns = []) {
  const column = columns.find((item) => item.id === status);
  if (column?.linearStateId && states.some((state) => state.id === column.linearStateId)) return column.linearStateId;
  const issueStateId = String(status || "").replace(/^linear_/, "").replace(/_/g, "-");
  const byId = states.find((state) => normalizeLinearName(state.id).replace(/\s/g, "") === normalizeLinearName(issueStateId).replace(/\s/g, ""));
  if (byId?.id) return byId.id;
  const aliases = {
    backlog: ["backlog", "triage"],
    todo: ["todo", "to do", "planned", "unstarted"],
    in_progress: ["in_progress", "in progress", "started"],
    in_review: ["in_review", "in review", "review"],
    done: ["done", "completed", "complete"],
  }[String(status || "").toLowerCase()] || [];
  const normalized = new Set(aliases.map(normalizeLinearName));
  const found = states.find((state) => normalized.has(normalizeLinearName(state.name)));
  return found?.id || "";
}

function linearColumnsFromStates(states) {
  return states
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || String(a.name).localeCompare(String(b.name)))
    .map((state) => ({
      id: linearStatusId(state),
      title: state.name || "Untitled",
      linearStateId: state.id,
      linearType: state.type || "",
    }));
}

function linearStatusId(state) {
  const stateId = String(state?.id || "").trim();
  if (stateId) return `linear_${stateId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
  return normalizeLinearName(state?.name).replace(/\s/g, "_") || "backlog";
}

function linearIssueFromApi(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    dueDate: issue.dueDate,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    state: issue.state,
    assignee: issue.assignee?.displayName || issue.assignee?.name || issue.assignee?.email || "",
    labels: Array.isArray(issue.labels?.nodes) ? issue.labels.nodes.map((label) => label.name).filter(Boolean) : [],
  };
}

function normalizeLinearName(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function issueAssignedToViewer(issue, viewer) {
  const assignee = normalizeLinearName(issue.assignee);
  if (!assignee) return false;
  const candidates = [viewer?.name, viewer?.displayName, viewer?.email]
    .map(normalizeLinearName)
    .filter(Boolean);
  return candidates.some((candidate) => assignee === candidate || assignee.includes(candidate) || candidate.includes(assignee));
}

function createLinearClient(apiKey, apiUrl = "https://api.linear.app/graphql") {
  const endpoint = String(apiUrl || "").trim() || "https://api.linear.app/graphql";
  if (endpoint === "mock://linear") return createMockLinearClient();
  const authorization = /^lin_oauth_/i.test(apiKey) ? `Bearer ${apiKey}` : apiKey;
  async function request(query, variables = {}) {
    if (typeof fetch !== "function") throw new Error("Linear sync requires Node.js 18+ fetch support");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Linear returned non-JSON response (${response.status})`);
    }
    if (!response.ok) throw new Error(linearHttpErrorMessage(response.status, payload.errors?.[0]?.message || text));
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    return payload.data || {};
  }

  return {
    async viewer() {
      const data = await request(`
        query ProjectHomeViewer {
          viewer { id name displayName email }
        }
      `);
      return data.viewer || {};
    },
    async teams() {
      const data = await request(`
        query ProjectHomeTeams {
          teams {
            nodes { id name key }
          }
        }
      `);
      return data.teams?.nodes || [];
    },
    async teamStates(teamId) {
      const data = await request(`
        query ProjectHomeTeamStates($teamId: String!) {
          team(id: $teamId) {
            states {
              nodes { id name type position }
            }
          }
        }
      `, { teamId });
      return data.team?.states?.nodes || [];
    },
    async issues(teamId) {
      let after = null;
      const issues = [];
      do {
        const data = await request(`
          query ProjectHomeTeamIssues($teamId: ID!, $after: String) {
            issues(first: 100, after: $after, filter: { team: { id: { eq: $teamId } } }) {
              nodes {
                id
                identifier
                url
                title
                description
                priority
                dueDate
                createdAt
                updatedAt
                state { id name type position }
                assignee { name displayName email }
                labels { nodes { name } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `, { teamId, after });
        issues.push(...(data.issues?.nodes || []));
        after = data.issues?.pageInfo?.hasNextPage ? data.issues.pageInfo.endCursor : null;
      } while (after);
      return issues;
    },
    async createIssue(input) {
      const data = await request(`
        mutation ProjectHomeCreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier url title updatedAt }
          }
        }
      `, { input });
      const issue = data.issueCreate?.issue;
      if (!data.issueCreate?.success || !issue?.id) throw new Error("Linear issueCreate did not return an issue");
      return issue;
    },
    async updateIssue(id, input) {
      const { teamId, ...patch } = input;
      const data = await request(`
        mutation ProjectHomeUpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id identifier url title updatedAt }
          }
        }
      `, { id, input: patch });
      const issue = data.issueUpdate?.issue;
      if (!data.issueUpdate?.success || !issue?.id) throw new Error("Linear issueUpdate did not return an issue");
      return issue;
    },
  };
}

function linearHttpErrorMessage(status, detail) {
  if (status === 401) {
    return "Linear rejected the saved API key. Re-enter the personal API key in Settings > Project Home, then try again.";
  }
  return `Linear HTTP ${status}: ${detail}`;
}

function createMockLinearClient() {
  return {
    async viewer() {
      return { id: "user-test", name: "Test User", displayName: "Test User", email: "test@example.com" };
    },
    async teams() {
      return [{ id: "team-test", name: "Test Team", key: "LIN" }];
    },
    async teamStates() {
      return [
        { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-progress", name: "In Progress", type: "started", position: 2 },
        { id: "state-done", name: "Done", type: "completed", position: 3 },
        { id: "state-canceled", name: "Canceled", type: "canceled", position: 4 },
        { id: "state-duplicate", name: "Duplicate", type: "canceled", position: 5 },
      ];
    },
    async issues() {
      return [{
        id: "lin-existing-1",
        identifier: "LIN-99",
        url: "https://linear.app/acme/issue/LIN-99/existing",
        title: "Existing Linear issue",
        description: "Already in Linear",
        priority: 2,
        dueDate: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: { id: "state-canceled", name: "Canceled", type: "canceled", position: 4 },
        assignee: { name: "Test User", displayName: "Test User", email: "test@example.com" },
        labels: { nodes: [{ name: "linear" }] },
      }];
    },
    async createIssue(input) {
      return {
        id: "lin-created-1",
        identifier: "LIN-1",
        url: "https://linear.app/acme/issue/LIN-1",
        title: input.title,
        updatedAt: new Date().toISOString(),
      };
    },
    async updateIssue(id, input) {
      return {
        id,
        identifier: "LIN-1",
        url: "https://linear.app/acme/issue/LIN-1",
        title: input.title,
        updatedAt: new Date().toISOString(),
      };
    },
  };
}

function respond(message) {
  // Codex's rmcp transport speaks newline-delimited JSON (NDJSON), not LSP-style
  // Content-Length framing. Write a single line per message.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requireString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}
