#!/usr/bin/env node
"use strict";

// End-to-end smoke test for mcp-server.js.
// Spawns the server, drives it over stdio with NDJSON-framed JSON-RPC,
// and exercises every tool. Uses CODEX_PLUSPLUS_DATA_DIR to keep the
// real issue DB untouched.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createIssueStore } = require("../project-home-store");

const SERVER = path.resolve(__dirname, "..", "mcp-server.js");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-mcp-"));
const projectPath = path.join(os.tmpdir(), "ph-mcp-fake-project");
// Prefix derived from first 3 alphanumeric chars of basename `ph-mcp-fake-project`.
const PFX = "PHM";

let buf = "";
const pending = new Map();
let child = null;

async function startServers() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CODEX_PLUSPLUS_DATA_DIR: dataDir,
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_API_URL: "mock://linear",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });
}

let nextId = 1;
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
    // Codex's rmcp transport uses NDJSON, not Content-Length framing.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function call(name, args) {
  return send("tools/call", { name, arguments: args }).then((r) => JSON.parse(r.content[0].text));
}

const results = [];
function check(label, cond, detail = "") {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}

(async () => {
  try {
    await startServers();
    const init = await send("initialize", { protocolVersion: "2024-11-05" });
    check("initialize returns serverInfo", init.serverInfo?.name === "project-home");

    const list = await send("tools/list", {});
    check("tools/list returns 11 tools", Array.isArray(list.tools) && list.tools.length === 11, `got ${list.tools?.length}`);
    const toolNames = (list.tools || []).map((t) => t.name);
    check("tools/list includes project_home_help", toolNames.includes("project_home_help"));
    check("tools/list includes project_home_search_issues", toolNames.includes("project_home_search_issues"));
    check("tools/list includes project_home_linear_sync", toolNames.includes("project_home_linear_sync"));

    // Help tool: overview
    const helpOverviewRes = await send("tools/call", { name: "project_home_help", arguments: {} });
    const helpOverview = helpOverviewRes.content[0].text;
    check("help overview is plain text (not JSON)", typeof helpOverview === "string" && !helpOverview.startsWith("{"));
    check("help overview lists create_issue", helpOverview.includes("project_home_create_issue"));
    check("help overview mentions Codex author convention", /author.*Codex/i.test(helpOverview));

    // Help tool: focused (with and without prefix)
    const helpFocusedRes = await send("tools/call", { name: "project_home_help", arguments: { tool: "create_issue" } });
    const helpFocused = helpFocusedRes.content[0].text;
    check("help focused returns create_issue section", helpFocused.startsWith("project_home_create_issue") && helpFocused.includes("newCommentAuthor"));

    const helpPrefixedRes = await send("tools/call", { name: "project_home_help", arguments: { tool: "project_home_move_issue" } });
    check("help accepts prefixed tool name", helpPrefixedRes.content[0].text.startsWith("project_home_move_issue"));

    const helpUnknownRes = await send("tools/call", { name: "project_home_help", arguments: { tool: "nope" } });
    check("help reports unknown tool", /Unknown tool/.test(helpUnknownRes.content[0].text));

    const helpNoPathRes = await send("tools/call", { name: "project_home_help", arguments: {} });
    check("help works without projectPath", typeof helpNoPathRes.content[0].text === "string");

    const cols = await call("project_home_columns", { projectPath });
    check("columns has 5 default columns", cols.columns?.length === 5);
    check("columns has priorities", Array.isArray(cols.priorities) && cols.priorities.includes("urgent"));

    const empty = await call("project_home_list_issues", { projectPath });
    check("initial list is empty", empty.issues.length === 0);

    const created = await call("project_home_create_issue", {
      projectPath,
      title: "First issue",
      description: "test desc",
      priority: "high",
      labels: ["bug", "urgent-ui"],
      newComment: "kickoff comment",
    });
    check("create returns derived prefix id", created.issue.id === `${PFX}-1`, created.issue.id);
    check("create stores priority", created.issue.priority === "high");
    check("create stores labels", JSON.stringify(created.issue.labels) === JSON.stringify(["bug", "urgent-ui"]));
    check("create appends initial comment", created.issue.comments.length === 1 && created.issue.comments[0].body === "kickoff comment");

    const created2 = await call("project_home_create_issue", { projectPath, title: "Second" });
    check("second issue increments", created2.issue.id === `${PFX}-2`);

    const searchTitle = await call("project_home_search_issues", { projectPath, query: "first" });
    check("search matches title", searchTitle.issues.length === 1 && searchTitle.issues[0].id === `${PFX}-1`);

    const searchLabel = await call("project_home_search_issues", { projectPath, query: "urgent-ui" });
    check("search matches label", searchLabel.issues.length === 1 && searchLabel.issues[0].id === `${PFX}-1`);

    const searchMissing = await call("project_home_search_issues", { projectPath, query: "does-not-exist" });
    check("search returns empty matches", searchMissing.issues.length === 0 && searchMissing.query === "does-not-exist");

    const got = await call("project_home_get_issue", { projectPath, issueId: `${PFX}-1` });
    check("get_issue retrieves issue", got?.id === `${PFX}-1` && got.title === "First issue");

    const updated = await call("project_home_update_issue", {
      projectPath,
      issueId: `${PFX}-1`,
      title: "Renamed",
      status: "in_progress",
      dueDate: "2026-01-15",
    });
    check("update changes title", updated.issue.title === "Renamed");
    check("update changes status", updated.issue.status === "in_progress");
    check("update sets dueDate", updated.issue.dueDate === "2026-01-15");

    const commented = await call("project_home_add_comment", {
      projectPath, issueId: `${PFX}-1`, body: "second comment", author: "Codex",
    });
    check("add_comment appends", commented.issue.comments.length === 2);
    check("add_comment stores author", commented.issue.comments[1].author === "Codex",
      commented.issue.comments[1].author);

    const withAuthored = await call("project_home_update_issue", {
      projectPath, issueId: `${PFX}-1`, newComment: "decision note", newCommentAuthor: "Codex",
    });
    const last = withAuthored.issue.comments[withAuthored.issue.comments.length - 1];
    check("update newCommentAuthor stored", last.author === "Codex" && last.body === "decision note");

    const moved = await call("project_home_move_issue", {
      projectPath, issueId: `${PFX}-1`, status: "done",
    });
    check("move changes status to done", moved.issue.status === "done" && moved.issue.rank === 0);

    const moved2 = await call("project_home_move_issue", {
      projectPath, issueId: `${PFX}-2`, status: "done", beforeIssueId: `${PFX}-1`,
    });
    const doneCol = moved2.board.issues.filter((i) => i.status === "done");
    check("beforeIssueId reorders correctly", doneCol[0].id === `${PFX}-2` && doneCol[1].id === `${PFX}-1`,
      doneCol.map((i) => i.id).join(","));

    const dryRun = await call("project_home_linear_sync", { projectPath, issueId: `${PFX}-1`, dryRun: true });
    check("linear dryRun plans update/create", dryRun.dryRun === true && dryRun.synced[0].issueId === `${PFX}-1`);
    check("linear sync falls back to first accessible team", dryRun.teamId === "team-test", dryRun.teamId);
    check("linear dryRun leaves metadata empty", !dryRun.board.issues.find((i) => i.id === `${PFX}-1`)?.linear?.id);

    const synced = await call("project_home_linear_sync", { projectPath, issueId: `${PFX}-1` });
    check("linear sync creates issue", synced.synced[0].linearId === "" && synced.synced[0].id === "lin-created-1");
    check("linear sync stores metadata", synced.board.issues.find((i) => i.id === `${PFX}-1`)?.linear?.identifier === "LIN-1");

    const updatedLinear = await call("project_home_linear_sync", { projectPath, issueId: `${PFX}-1` });
    check("linear sync updates linked issue", updatedLinear.synced[0].action === "update" && updatedLinear.synced[0].linearId === "lin-created-1");

    const assignedSkipped = await call("project_home_linear_sync", { projectPath, issueId: `${PFX}-1`, dryRun: true, assignedToMeOnly: true });
    check("linear assigned-only skips other assignee", assignedSkipped.skipped[0].issueId === `${PFX}-1`);

    await call("project_home_update_issue", { projectPath, issueId: `${PFX}-1`, assignee: "Test User" });
    const assignedSynced = await call("project_home_linear_sync", { projectPath, issueId: `${PFX}-1`, dryRun: true, assignedToMeOnly: true });
    check("linear assigned-only syncs viewer assignee", assignedSynced.synced[0].issueId === `${PFX}-1` && assignedSynced.skipped.length === 0);

    const deleted = await call("project_home_delete_issue", { projectPath, issueId: `${PFX}-2` });
    check("delete removes issue", deleted.board.issues.every((i) => i.id !== `${PFX}-2`));

    let errored = false;
    try { await call("project_home_get_issue", { projectPath: "" }); }
    catch (e) { errored = /projectPath is required/.test(e.message); }
    check("missing projectPath rejected", errored);

    let unknownErr = false;
    try { await send("tools/call", { name: "bogus", arguments: { projectPath } }); }
    catch (e) { unknownErr = /Unknown tool/.test(e.message); }
    check("unknown tool rejected", unknownErr);

    const issuesDir = path.join(dataDir, "project-home", "issues");
    const files = fs.readdirSync(issuesDir);
    check("db file persisted", files.length === 1 && files[0].endsWith(".json"), files.join(","));

    const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-settings-"));
    const settingsStore = createIssueStore({ root: settingsRoot });
    const settingsBoard = settingsStore.updateSettings(projectPath, {
      linear: {
        enabled: true,
        teamId: "team-settings",
        apiKey: "lin_api_settings",
        apiUrl: "https://api.linear.app/graphql",
        defaultSyncMode: "write",
        assignedToMeOnly: true,
      },
    });
    check("settings save persists Linear config", settingsBoard.settings.linear.teamId === "team-settings" && settingsBoard.settings.linear.enabled === true);
    check("settings save keeps API key", settingsBoard.settings.linear.apiKey === "lin_api_settings");
    check("settings save keeps assigned-only flag", settingsBoard.settings.linear.assignedToMeOnly === true);
    const settingsReloaded = settingsStore.list(projectPath);
    check("settings reload from disk", settingsReloaded.settings.linear.defaultSyncMode === "write");
    try { fs.rmSync(settingsRoot, { recursive: true, force: true }); } catch {}

  } catch (err) {
    console.error("Test harness error:", err);
    results.push({ label: "harness", ok: false });
  } finally {
    if (child) {
      child.stdin.end();
      child.kill();
    }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
