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
    case "project_home_columns":
      return content({
        columns: DEFAULT_COLUMNS,
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
  const status = {
    type: "string",
    enum: DEFAULT_COLUMNS.map((column) => column.id),
    description: "Kanban column id.",
  };
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
      "- project_home_get_issue     fetch a single issue by id.",
      "- project_home_create_issue  create a new issue.",
      "- project_home_update_issue  patch any issue field, optionally append a comment.",
      "- project_home_add_comment   append a single comment.",
      "- project_home_move_issue    change an issue's status (and optional ordering).",
      "- project_home_delete_issue  remove an issue.",
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
  };

  if (!toolName) return sections.overview;
  const key = String(toolName).trim().replace(/^project_home_/, "");
  const fullKey = `project_home_${key}`;
  if (sections[fullKey]) return sections[fullKey];
  if (sections[key]) return sections[key];
  return `Unknown tool "${toolName}". Call project_home_help with no arguments to list available tools.`;
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
