"use strict";

const DEFAULT_STATUS_OPTIONS = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "In Progress" },
  { id: "in_review", title: "In Review" },
  { id: "done", title: "Done" },
];

const DEFAULT_PRIORITY_OPTIONS = ["urgent", "high", "medium", "low", "none"];
const FORM_ATTR = "data-codexpp-project-home-issue-form";
let nextIssueFormId = 0;

function createProjectHomeIssueModal(options = {}) {
  const id = nextId("issue-modal");
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const onCancel = asFunction(options.onCancel);

  const overlay = element("div", {
    className:
      "fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6",
    attrs: {
      [FORM_ATTR]: "overlay",
    },
  });

  const panel = element("div", {
    className:
      "flex max-h-[min(760px,calc(100vh-3rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-token-border bg-token-main-surface-primary shadow-xl",
    attrs: {
      [FORM_ATTR]: "dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": descriptionId,
    },
  });

  const formApi = createProjectHomeIssueForm({
    ...options,
    id,
    titleId,
    descriptionId,
    variant: "modal",
    onCancel: () => {
      onCancel();
      overlay.remove();
    },
  });

  overlay.addEventListener("pointerdown", (event) => {
    if (event.target !== overlay) return;
    event.preventDefault();
    onCancel();
    overlay.remove();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
    overlay.remove();
  });

  panel.append(formApi.root);
  overlay.append(panel);

  return {
    root: overlay,
    panel,
    form: formApi.form,
    fields: formApi.fields,
    focus: formApi.focus,
    getValue: formApi.getValue,
    setValue: formApi.setValue,
    close() {
      overlay.remove();
    },
    destroy() {
      formApi.destroy();
      overlay.remove();
    },
  };
}

function createProjectHomeIssueForm(options = {}) {
  const mode = options.mode === "edit" ? "edit" : "create";
  const issue = normalizeIssue(options.issue);
  const id = options.id || nextId("issue-form");
  const titleId = options.titleId || `${id}-title`;
  const descriptionId = options.descriptionId || `${id}-description`;
  const statuses = normalizeOptionList(options.statuses, DEFAULT_STATUS_OPTIONS);
  const priorities = normalizeOptionList(options.priorities, DEFAULT_PRIORITY_OPTIONS);
  const onSubmit = asFunction(options.onSubmit);
  const onCancel = asFunction(options.onCancel);
  const onDelete = asFunction(options.onDelete);
  let destroyed = false;
  let pending = false;

  const root = element("section", {
    className: options.variant === "modal"
      ? "flex min-h-0 flex-col"
      : "rounded-lg border border-token-border-light bg-token-main-surface-primary shadow-sm",
    attrs: {
      [FORM_ATTR]: "root",
      "aria-labelledby": titleId,
    },
  });

  const form = element("form", {
    className: "flex min-h-0 flex-col",
    attrs: {
      [FORM_ATTR]: "form",
      novalidate: "",
    },
  });

  const heading = element("div", {
    className:
      "flex shrink-0 items-start justify-between gap-4 border-b border-token-border-light px-4 py-3",
  });
  const headingText = element("div", { className: "min-w-0" });
  const title = element("h2", {
    className: "text-base font-medium leading-6 text-token-foreground",
    text: options.title || (mode === "edit" ? "Edit issue" : "New issue"),
    attrs: { id: titleId },
  });
  const description = element("p", {
    className: "mt-1 text-sm leading-5 text-token-description-foreground",
    text: options.description || "Issue details",
    attrs: { id: descriptionId },
  });
  headingText.append(title, description);
  heading.append(headingText);

  const body = element("div", {
    className:
      "grid min-h-0 gap-4 overflow-y-auto px-4 py-4 sm:grid-cols-2",
  });

  const titleInput = textInput({
    id: `${id}-title-input`,
    value: issue.title,
    required: true,
    placeholder: "Untitled issue",
  });
  const descriptionInput = textarea({
    id: `${id}-description-input`,
    value: issue.description,
    placeholder: "Describe the work, context, or acceptance criteria.",
  });
  const statusInput = selectInput({
    id: `${id}-status-input`,
    value: issue.status,
    options: statuses,
  });
  const priorityInput = selectInput({
    id: `${id}-priority-input`,
    value: issue.priority,
    options: priorities,
  });
  const labelsInput = textInput({
    id: `${id}-labels-input`,
    value: labelsToText(issue.labels),
    placeholder: "bug, ui, follow-up",
  });
  const assigneeInput = textInput({
    id: `${id}-assignee-input`,
    value: issue.assignee,
    placeholder: "Name or handle",
  });
  const dueDateInput = textInput({
    id: `${id}-due-date-input`,
    value: issue.dueDate,
    placeholder: "YYYY-MM-DD",
    type: "date",
  });
  const commentInput = textarea({
    id: `${id}-comment-input`,
    value: "",
    placeholder: "Add context, decisions, or next steps.",
  });

  body.append(
    field("Title", titleInput, { required: true, className: "sm:col-span-2" }),
    field("Description", descriptionInput, { className: "sm:col-span-2" }),
    field("Status", statusInput),
    field("Priority", priorityInput),
    field("Deadline", dueDateInput),
    field("Assignee", assigneeInput),
    field("Labels", labelsInput, { hint: "Separate labels with commas." }),
    field(mode === "edit" ? "Add comment" : "Initial comment", commentInput, { className: "sm:col-span-2" }),
  );

  const error = element("div", {
    className:
      "hidden border-t border-token-border-light px-4 py-2 text-sm text-red-500",
    attrs: {
      [FORM_ATTR]: "error",
      role: "alert",
    },
  });

  const footer = element("div", {
    className:
      "flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-token-border-light px-4 py-3",
  });
  const destructive = element("div", { className: "min-w-0" });
  const actions = element("div", { className: "ml-auto flex items-center gap-2" });

  const cancelButton = button("Cancel", "secondary");
  const submitButton = button(mode === "edit" ? "Save changes" : "Create issue", "primary");
  const deleteButton = button("Delete", "danger");

  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (pending) return;
    onCancel(getValue());
  });
  submitButton.addEventListener("click", () => {
    form.requestSubmit();
  });
  deleteButton.addEventListener("click", async (event) => {
    event.preventDefault();
    if (pending) return;
    await runCallback(onDelete, getValue());
  });

  if (mode === "edit" && options.showDelete !== false && options.onDelete) {
    destructive.append(deleteButton);
  }
  actions.append(cancelButton, submitButton);
  footer.append(destructive, actions);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending) return;
    const value = getValue();
    if (!value.title) {
      showError("Title is required.");
      titleInput.focus();
      return;
    }
    await runCallback(onSubmit, value);
  });

  form.append(heading, body, error, footer);
  root.append(form);

  const fields = {
    title: titleInput,
    description: descriptionInput,
    status: statusInput,
    priority: priorityInput,
    labels: labelsInput,
    assignee: assigneeInput,
    dueDate: dueDateInput,
    newComment: commentInput,
  };

  function getValue() {
    return normalizeIssueFormValue({
      ...issue,
      title: titleInput.value,
      description: descriptionInput.value,
      status: statusInput.value,
      priority: priorityInput.value,
      labels: labelsInput.value,
      assignee: assigneeInput.value,
      dueDate: dueDateInput.value,
      newComment: commentInput.value,
    });
  }

  function setValue(nextIssue = {}) {
    const normalized = normalizeIssue({ ...issue, ...nextIssue });
    titleInput.value = normalized.title;
    descriptionInput.value = normalized.description;
    statusInput.value = optionValueOrFallback(normalized.status, statuses);
    priorityInput.value = optionValueOrFallback(normalized.priority, priorities);
    labelsInput.value = labelsToText(normalized.labels);
    assigneeInput.value = normalized.assignee;
    dueDateInput.value = normalized.dueDate;
    commentInput.value = "";
    hideError();
  }

  function focus() {
    titleInput.focus();
    titleInput.select();
  }

  function destroy() {
    destroyed = true;
    root.remove();
  }

  async function runCallback(callback, value) {
    hideError();
    setPending(true);
    try {
      await callback(value);
    } catch (cause) {
      if (!destroyed) showError(cause?.message || String(cause));
    } finally {
      if (!destroyed) setPending(false);
    }
  }

  function setPending(nextPending) {
    pending = nextPending;
    submitButton.disabled = pending;
    cancelButton.disabled = pending;
    deleteButton.disabled = pending;
    root.toggleAttribute("aria-busy", pending);
  }

  function showError(message) {
    error.textContent = message;
    error.classList.remove("hidden");
  }

  function hideError() {
    error.textContent = "";
    error.classList.add("hidden");
  }

  return {
    root,
    form,
    fields,
    buttons: {
      submit: submitButton,
      cancel: cancelButton,
      delete: deleteButton,
    },
    focus,
    getValue,
    setValue,
    destroy,
  };
}

function normalizeIssueFormValue(value = {}) {
  return {
    id: cleanText(value.id),
    title: cleanText(value.title),
    description: cleanMultilineText(value.description),
    status: cleanText(value.status) || "backlog",
    priority: cleanText(value.priority) || "none",
    labels: textToLabels(value.labels),
    assignee: cleanText(value.assignee),
    dueDate: normalizeDueDate(value.dueDate || value.deadline),
    newComment: cleanMultilineText(value.newComment || value.comment),
  };
}

function field(labelText, control, options = {}) {
  const label = element("label", {
    className: [
      "flex min-w-0 flex-col gap-1.5",
      options.className || "",
    ].filter(Boolean).join(" "),
    attrs: { for: control.id },
  });
  const labelRow = element("span", {
    className: "flex items-center gap-1 text-sm font-medium text-token-foreground",
  });
  labelRow.append(element("span", { text: labelText }));
  if (options.required) {
    labelRow.append(element("span", {
      className: "text-red-500",
      text: "*",
      attrs: { "aria-hidden": "true" },
    }));
  }
  label.append(labelRow, control);
  if (options.hint) {
    label.append(element("span", {
      className: "text-xs leading-4 text-token-description-foreground",
      text: options.hint,
    }));
  }
  return label;
}

function textInput(options = {}) {
  const input = element("input", {
    className: inputClassName(),
    attrs: {
      id: options.id,
      type: options.type || "text",
      autocomplete: "off",
      placeholder: options.placeholder || "",
    },
  });
  if (options.required) input.required = true;
  input.value = cleanText(options.value);
  return input;
}

function textarea(options = {}) {
  const input = element("textarea", {
    className: `${inputClassName()} min-h-28 resize-y leading-5`,
    attrs: {
      id: options.id,
      rows: "5",
      placeholder: options.placeholder || "",
    },
  });
  input.value = cleanMultilineText(options.value);
  return input;
}

function selectInput(options = {}) {
  const input = element("select", {
    className: inputClassName(),
    attrs: { id: options.id },
  });
  const selectedValue = optionValueOrFallback(options.value, options.options);
  for (const option of options.options || []) {
    const optionEl = element("option", {
      text: option.title,
      attrs: { value: option.id },
    });
    input.append(optionEl);
  }
  input.value = selectedValue;
  return input;
}

function button(label, tone) {
  const classes = {
    primary:
      "bg-token-text-primary text-token-main-surface-primary hover:opacity-90",
    secondary:
      "border border-token-border-light text-token-foreground hover:bg-token-list-hover-background",
    danger:
      "border border-red-500/50 text-red-500 hover:bg-red-500/10",
  };
  return element("button", {
    className: [
      "inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-token-border focus-visible:outline-2",
      classes[tone] || classes.secondary,
    ].join(" "),
    text: label,
    attrs: { type: "button" },
  });
}

function inputClassName() {
  return [
    "w-full rounded-md border border-token-border-light bg-token-input-background px-3 py-2 text-sm text-token-foreground",
    "placeholder:text-token-description-foreground",
    "focus:border-token-border focus:outline-none focus:ring-2 focus:ring-token-border-light",
  ].join(" ");
}

function normalizeIssue(issue = {}) {
  return normalizeIssueFormValue({
    id: issue.id,
    title: issue.title,
    description: issue.description,
    status: issue.status || "backlog",
    priority: issue.priority || "none",
    labels: issue.labels,
    assignee: issue.assignee,
    dueDate: issue.dueDate || issue.deadline,
  });
}

function normalizeDueDate(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function normalizeOptionList(options, fallback) {
  const source = Array.isArray(options) && options.length > 0 ? options : fallback;
  return source
    .map((option) => {
      if (typeof option === "string") {
        const id = cleanText(option);
        return id ? { id, title: labelForOption(id) } : null;
      }
      const id = cleanText(option?.id || option?.value);
      const title = cleanText(option?.title || option?.label || labelForOption(id));
      return id ? { id, title } : null;
    })
    .filter(Boolean);
}

function optionValueOrFallback(value, options) {
  const normalizedValue = cleanText(value);
  if ((options || []).some((option) => option.id === normalizedValue)) return normalizedValue;
  return options?.[0]?.id || "";
}

function labelForOption(value) {
  const text = cleanText(value).replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function labelsToText(labels) {
  return textToLabels(labels).join(", ");
}

function textToLabels(value) {
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map(cleanText)
    .filter(Boolean);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanMultilineText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function element(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs || {})) {
    if (value == null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of options.children || []) {
    if (child) node.append(child);
  }
  return node;
}

function asFunction(value) {
  return typeof value === "function" ? value : () => {};
}

function nextId(scope) {
  nextIssueFormId += 1;
  return `codexpp-project-home-${scope}-${nextIssueFormId}`;
}

module.exports = {
  DEFAULT_PRIORITY_OPTIONS,
  DEFAULT_STATUS_OPTIONS,
  createProjectHomeIssueForm,
  createProjectHomeIssueModal,
  normalizeIssueFormValue,
};
