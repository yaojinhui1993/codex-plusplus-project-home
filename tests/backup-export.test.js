#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createIssueStore } = require("../project-home-store");

test("backupProject writes a restorable JSON snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ph-backup-"));
  try {
    const projectPath = path.join(os.tmpdir(), "backup-project");
    const store = createIssueStore({ root });
    const created = store.create(projectPath, {
      title: "Back me up",
      priority: "high",
      labels: ["backup"],
      newComment: "Keep this safe",
      newCommentAuthor: "Codex",
    }).issue;
    store.updateSettings(projectPath, { activeIssueId: created.id });

    const result = store.backupProject(projectPath, { now: "2026-05-01T12:34:56.000Z" });
    assert.equal(typeof result.path, "string");
    assert.match(result.path, /backups\/project-home\/backup-project-2026-05-01T12-34-56-000Z\.json$/);
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(result.backup.format, "project-home-backup");
    assert.equal(result.backup.board.issues[0].title, "Back me up");
    assert.equal(result.backup.board.settings.activeIssueId, created.id);

    store.delete(projectPath, created.id);
    assert.equal(store.list(projectPath).issues.length, 0);

    const restored = store.restoreProject(projectPath, JSON.parse(fs.readFileSync(result.path, "utf8")));
    assert.equal(restored.issues.length, 1);
    assert.equal(restored.issues[0].title, "Back me up");
    assert.equal(restored.settings.activeIssueId, created.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
