#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const projectHome = require("../index.js");

test("buildResumeSnapshot summarizes open work and prioritizes focus issues", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildResumeSnapshot, "function");

  const snapshot = helpers.buildResumeSnapshot({
    current: {
      label: "sniper-system",
      path: "/Users/yjh/Playground/sniper-system",
    },
    board: {
      settings: { activeIssueId: "SNI-1" },
      issues: [
        { id: "SNI-1", title: "Fix regression colors", status: "in_progress", priority: "high", rank: 2 },
        { id: "SNI-2", title: "Done item", status: "done", priority: "urgent", rank: 0 },
        { id: "SNI-3", title: "Backlog item", status: "backlog", priority: "none", rank: 1 },
        { id: "SNI-4", title: "Review item", status: "in_review", priority: "medium", rank: 0 },
        { id: "SNI-5", title: "Add Opinion Source AI chat", status: "todo", priority: "urgent", rank: 0 },
      ],
    },
  });

  assert.equal(snapshot.projectLabel, "sniper-system");
  assert.equal(snapshot.projectPath, "/Users/yjh/Playground/sniper-system");
  assert.deepEqual(snapshot.openCounts, {
    backlog: 1,
    todo: 1,
    in_progress: 1,
    in_review: 1,
  });
  assert.deepEqual(snapshot.focusIssues.map((issue) => issue.id), ["SNI-5", "SNI-1", "SNI-4", "SNI-3"]);
  assert.equal(snapshot.activeIssue.issueId, "SNI-1");
});

test("buildWorkSessionLaunchPayload bridges the current session into Focus Composer", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildWorkSessionLaunchPayload, "function");

  const payload = helpers.buildWorkSessionLaunchPayload({
    current: {
      label: "sniper-system",
      path: "/Users/yjh/Playground/sniper-system",
    },
    board: {
      settings: { activeIssueId: "SNI-1" },
      issues: [
        { id: "SNI-1", title: "Fix regression colors", status: "in_progress", priority: "high", rank: 2 },
        { id: "SNI-2", title: "Done item", status: "done", priority: "urgent", rank: 0 },
        { id: "SNI-5", title: "Add Opinion Source AI chat", status: "todo", priority: "urgent", rank: 0 },
      ],
    },
  });

  assert.equal(payload.kind, "work-session");
  assert.equal(payload.source, "project-home");
  assert.equal(payload.project.projectLabel, "sniper-system");
  assert.equal(payload.project.projectPath, "/Users/yjh/Playground/sniper-system");
  assert.equal(payload.activeIssue.issueId, "SNI-1");
  assert.deepEqual(payload.project.focusIssues.map((issue) => issue.id), ["SNI-5", "SNI-1"]);
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildShipNoteLaunchPayload marks an end-session launch for Focus Composer", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildShipNoteLaunchPayload, "function");

  const payload = helpers.buildShipNoteLaunchPayload({
    current: {
      label: "sniper-system",
      path: "/Users/yjh/Playground/sniper-system",
    },
    board: {
      settings: { activeIssueId: "SNI-1" },
      issues: [
        { id: "SNI-1", title: "Fix regression colors", status: "in_progress", priority: "high", rank: 0 },
        { id: "SNI-7", title: "Review Codex tweak crash recovery", status: "in_review", priority: "high", rank: 1 },
      ],
    },
  });

  assert.equal(payload.kind, "ship-note");
  assert.equal(payload.source, "project-home");
  assert.equal(payload.project.projectLabel, "sniper-system");
  assert.equal(payload.activeIssue.issueId, "SNI-1");
  assert.deepEqual(payload.project.focusIssues.map((issue) => issue.id), ["SNI-1", "SNI-7"]);
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("Focus Composer launches from Project Home restore the native chat route", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.shouldRestoreNativeRouteForFocusLaunch, "function");

  assert.equal(helpers.shouldRestoreNativeRouteForFocusLaunch({ kind: "work-session" }), true);
  assert.equal(helpers.shouldRestoreNativeRouteForFocusLaunch({ kind: "ship-note" }), true);
  assert.equal(helpers.shouldRestoreNativeRouteForFocusLaunch({ kind: "project-brain" }), true);
  assert.equal(helpers.shouldRestoreNativeRouteForFocusLaunch({ kind: "open-composer" }), false);
});

test("buildProjectHomeQuickActions registers start and ship-note actions", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildProjectHomeQuickActions, "function");

  const actions = helpers.buildProjectHomeQuickActions({});
  assert.deepEqual(actions.map((action) => action.id), [
    "quick-capture",
    "open-project-command-center",
    "copy-project-git-status",
    "open-github-desktop",
    "open-project-brain",
    "create-session-digest",
    "copy-project-brain-pack",
    "start-work-session",
    "end-session-ship-note",
  ]);
  assert.equal(actions[0].source, "project-home");
  assert.equal(actions[0].title, "Quick Capture to Project Home");
  assert.equal(actions[1].title, "Open Project Command Center");
  assert.equal(actions[2].title, "Copy Project Git Status");
  assert.equal(actions[3].title, "Open in GitHub Desktop");
  assert.equal(actions[4].title, "Open Project Brain");
  assert.equal(actions[5].title, "Create Session Digest");
  assert.equal(actions[6].title, "Copy Project Brain Pack");
  assert.equal(actions[7].title, "Start Work Session");
  assert.equal(actions[8].title, "End Session / Ship Note");
  assert.equal(actions[0].isDisabled({}), true);
  assert.equal(actions[0].isDisabled({ project: { projectLabel: "sniper-system" } }), true);
  assert.equal(actions[0].isDisabled({ project: { projectPath: "/Users/yjh/Playground/sniper-system" } }), false);
  assert.equal(actions[1].isDisabled({}), true);
  assert.equal(actions[2].isDisabled({}), true);
  assert.equal(actions[3].isDisabled({}), true);
  assert.equal(actions[4].isDisabled({}), true);
  assert.equal(actions[5].isDisabled({}), true);
  assert.equal(actions[6].isDisabled({}), true);
  assert.equal(actions[7].isDisabled({ project: { projectLabel: "sniper-system" } }), false);
  assert.equal(actions[8].isDisabled({ activeIssue: { issueId: "SNI-1" } }), false);
  assert.equal(typeof actions[0].run, "function");
  assert.equal(typeof actions[1].run, "function");
  assert.equal(typeof actions[2].run, "function");
  assert.equal(typeof actions[3].run, "function");
  assert.equal(typeof actions[4].run, "function");
  assert.equal(typeof actions[5].run, "function");
  assert.equal(typeof actions[6].run, "function");
  assert.equal(typeof actions[7].run, "function");
  assert.equal(typeof actions[8].run, "function");
});

test("Project Command Center snapshot summarizes git and project state", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildProjectCommandSnapshot, "function");
  assert.equal(typeof helpers.formatProjectGitStatus, "function");

  const snapshot = helpers.buildProjectCommandSnapshot({
    current: {
      label: "sniper-system",
      path: "/Users/yjh/Playground/sniper-system",
    },
    board: {
      settings: { activeIssueId: "SNI-1" },
      issues: [
        { id: "SNI-1", title: "Ship command center", status: "in_progress", priority: "high" },
        { id: "SNI-2", title: "Done", status: "done", priority: "none" },
        { id: "SNI-3", title: "Review", status: "in_review", priority: "medium" },
      ],
    },
    gitStatus: {
      isRepo: true,
      branch: "main",
      root: "/Users/yjh/Playground/sniper-system",
      changedFiles: ["M index.js", "?? tests/command-center.test.js"],
    },
  });

  assert.equal(snapshot.projectLabel, "sniper-system");
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.dirtyCount, 2);
  assert.deepEqual(snapshot.openCounts, { in_progress: 1, in_review: 1 });
  assert.equal(snapshot.activeIssue.issueId, "SNI-1");

  const formatted = helpers.formatProjectGitStatus(snapshot);
  assert.match(formatted, /^Project Git Status/);
  assert.match(formatted, /Branch: main/);
  assert.match(formatted, /M index\.js/);
  assert.match(formatted, /\?\? tests\/command-center\.test\.js/);
});

test("Project Brain snapshots format local memory and latest digest", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildProjectBrainSnapshot, "function");
  assert.equal(typeof helpers.formatProjectBrainPack, "function");

  const snapshot = helpers.buildProjectBrainSnapshot({
    current: {
      label: "sniper-system",
      path: "/Users/yjh/Playground/sniper-system",
    },
    board: {
      brain: {
        facts: "Renderer tweak",
        decisions: "Keep data local",
        commands: "npm test",
        pitfalls: "Repair after Codex upgrades",
        digests: [{
          id: "D-1",
          title: "Session digest 2026-05-01",
          body: "Shipped:\n- Project Brain",
          createdAt: "2026-05-01T12:00:00.000Z",
        }],
      },
    },
  });

  assert.equal(snapshot.projectLabel, "sniper-system");
  assert.equal(snapshot.brain.facts, "Renderer tweak");
  assert.equal(snapshot.latestDigest.id, "D-1");

  const pack = helpers.formatProjectBrainPack(snapshot);
  assert.match(pack, /^Project Brain/);
  assert.match(pack, /Facts:\nRenderer tweak/);
  assert.match(pack, /Latest Session Digest:/);
  assert.match(pack, /Project Brain/);
});

test("buildQuickCaptureIssueInput normalizes lightweight capture values", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildQuickCaptureIssueInput, "function");

  assert.deepEqual(helpers.buildQuickCaptureIssueInput({
    title: "  Fix visual boundary  ",
    description: "  compare the card borders  ",
    priority: "HIGH",
    labels: "capture, ui, capture",
  }), {
    title: "Fix visual boundary",
    description: "compare the card borders",
    status: "backlog",
    priority: "high",
    labels: ["capture", "ui"],
  });

  assert.deepEqual(helpers.buildQuickCaptureIssueInput({ title: "" }), {
    title: "Untitled capture",
    description: "",
    status: "backlog",
    priority: "none",
    labels: ["capture"],
  });
});

test("buildProjectHomeKeyboardShortcuts registers global and read-only board shortcuts", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.buildProjectHomeKeyboardShortcuts, "function");

  const shortcuts = helpers.buildProjectHomeKeyboardShortcuts();
  assert.equal(shortcuts[0].id, "open-project-home");
  assert.equal(shortcuts[0].combo, "Cmd+Shift+H");
  assert.equal(shortcuts[0].remappable, true);
  assert.ok(shortcuts.some((shortcut) => shortcut.id === "create-issue" && shortcut.combo === "C"));
  assert.ok(shortcuts.some((shortcut) => shortcut.id === "focus-search" && shortcut.combo === "/"));
  assert.equal(shortcuts.filter((shortcut) => shortcut.scope === "Project Home board").every((shortcut) => shortcut.remappable === false), true);
});

test("header icon controls opt out of Electron drag regions", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.headerControlInteractionStyle, "function");
  assert.deepEqual(helpers.headerControlInteractionStyle(), {
    webkitAppRegion: "no-drag",
    pointerEvents: "auto",
    position: "relative",
    zIndex: "20",
  });
});

test("native sidebar toggle labels are protected while Project Home is open", () => {
  const helpers = projectHome.__test || {};
  assert.equal(typeof helpers.isNativeSidebarToggleLabel, "function");

  assert.equal(helpers.isNativeSidebarToggleLabel("Hide sidebar"), true);
  assert.equal(helpers.isNativeSidebarToggleLabel("Show sidebar"), true);
  assert.equal(helpers.isNativeSidebarToggleLabel("Project Home settings"), false);
});
