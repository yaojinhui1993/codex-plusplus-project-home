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
