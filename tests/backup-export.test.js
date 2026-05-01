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
    store.updateBrain(projectPath, {
      facts: "Renderer-only tweak",
      decisions: "Keep Project Home local",
      commands: "npm test",
      pitfalls: "Run codexplusplus repair after app upgrades",
    });
    store.createSessionDigest(projectPath, {
      now: "2026-05-01T12:30:00.000Z",
      body: "Shipped:\n- Backup brain data",
    });

    const result = store.backupProject(projectPath, { now: "2026-05-01T12:34:56.000Z" });
    assert.equal(typeof result.path, "string");
    assert.match(result.path, /backups\/project-home\/backup-project-2026-05-01T12-34-56-000Z\.json$/);
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(result.backup.format, "project-home-backup");
    assert.equal(result.backup.board.issues[0].title, "Back me up");
    assert.equal(result.backup.board.settings.activeIssueId, created.id);
    assert.equal(result.backup.board.brain.facts, "Renderer-only tweak");
    assert.equal(result.backup.board.brain.digests.length, 1);

    store.delete(projectPath, created.id);
    store.updateBrain(projectPath, { facts: "", decisions: "", commands: "", pitfalls: "", digests: [] });
    assert.equal(store.list(projectPath).issues.length, 0);

    const restored = store.restoreProject(projectPath, JSON.parse(fs.readFileSync(result.path, "utf8")));
    assert.equal(restored.issues.length, 1);
    assert.equal(restored.issues[0].title, "Back me up");
    assert.equal(restored.settings.activeIssueId, created.id);
    assert.equal(restored.brain.decisions, "Keep Project Home local");
    assert.equal(restored.brain.digests[0].body, "Shipped:\n- Backup brain data");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Brain stores local memory and drafts session digests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ph-brain-"));
  try {
    const projectPath = path.join(os.tmpdir(), "brain-project");
    const store = createIssueStore({ root });
    const active = store.create(projectPath, {
      title: "Wire Project Brain",
      status: "in_progress",
      priority: "high",
    }).issue;
    store.create(projectPath, {
      title: "Backlog follow-up",
      status: "backlog",
      priority: "low",
    });
    store.updateSettings(projectPath, { activeIssueId: active.id });
    const board = store.updateBrain(projectPath, {
      facts: "Project Home owns local issues",
      commands: "npm test\nnode --check index.js",
    });

    assert.equal(board.brain.facts, "Project Home owns local issues");
    assert.match(board.brain.commands, /npm test/);

    const draft = store.buildSessionDigestDraft(projectPath, {
      now: "2026-05-01T13:00:00.000Z",
      verified: "npm test passed",
      next: "Sync active tweak",
      changedFiles: ["M index.js", "M project-home-store.js"],
    });
    assert.equal(draft.title, "Session digest 2026-05-01");
    assert.match(draft.body, /Active Issue: BRA-1 Wire Project Brain/);
    assert.match(draft.body, /M index\.js/);
    assert.match(draft.body, /npm test passed/);
    assert.match(draft.body, /Next session starter:\nSync active tweak/);

    const saved = store.createSessionDigest(projectPath, draft);
    assert.equal(saved.board.brain.digests.length, 1);
    assert.equal(saved.board.brain.digests[0].body, draft.body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
