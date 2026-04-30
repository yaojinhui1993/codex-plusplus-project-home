# Project Home

Adds a hover-only home icon to Codex project rows. Clicking it, or pressing `Cmd+Shift+H` from a project thread, opens a Project Home view for that project.

V1 includes a per-project kanban board for Linear-style issues:

- Columns: Backlog, Todo, In Progress, In Review, Done
- Create issues from the board or a column header
- Drag issues between columns
- Right-click or use the issue ellipsis menu to edit, move, or delete
- Issues are stored in a JSON DB keyed by project path

The tweak also includes `mcp-server.js`, a stdio MCP server backed by the same issue store. Tools:

- `project_home_columns`
- `project_home_list_issues`
- `project_home_get_issue`
- `project_home_create_issue`
- `project_home_update_issue`
- `project_home_add_comment`
- `project_home_move_issue`
- `project_home_delete_issue`

Issue ids use a per-project prefix derived from the first 2–3 alphanumeric characters of the project folder name (e.g. issues under `…/tweaks/` become `TWE-1`, `TWE-2`, …). Existing `PH-*` ids are preserved.

Comments support an `author` field. The MCP exposes it on `project_home_add_comment` (`author`) and on `project_home_create_issue` / `project_home_update_issue` (`newCommentAuthor`). The board renders `author · timestamp` when present. Agents should pass `author: "Codex"` when leaving notes.

## Registering the MCP with Codex

Codex++ does not currently forward `manifest.json#mcp` into Codex's own MCP runtime, so the agent will not see these tools until you register the server manually. Add this block to `~/.codex/config.toml` and restart Codex:

```toml
[mcp_servers.project-home]
command = "node"
args = ["/ABSOLUTE/PATH/TO/codex-plusplus/tweaks/co.bennett.project-home/mcp-server.js"]
```

On macOS the absolute path is typically `/Users/<you>/Library/Application Support/codex-plusplus/tweaks/co.bennett.project-home/mcp-server.js`.

To verify, ask Codex "what MCPs can you see?" — `project-home` should appear with the eight `project_home_*` tools. Once upstream Codex++ auto-registers MCP entries from tweak manifests, this manual step can go away.

> Note: Codex's Rust MCP transport speaks newline-delimited JSON (NDJSON) on stdio, not LSP-style `Content-Length` framing. `mcp-server.js` writes one JSON message per line accordingly.

## One-shot install via Codex

Don't want to edit TOML by hand? Open a Codex chat and paste the block below. Codex will locate the MCP server, add the `[mcp_servers.project-home]` entry to `~/.codex/config.toml` (idempotently), verify the server boots, and tell you to restart Codex.

````
Install the project-home MCP for me. Steps, in order:

1. Resolve the absolute path to `mcp-server.js` for the project-home tweak. On macOS this is:
   `/Users/$USER/Library/Application Support/codex-plusplus/tweaks/co.bennett.project-home/mcp-server.js`
   On Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/codex-plusplus/tweaks/co.bennett.project-home/mcp-server.js`
   Confirm the file exists with `ls -la` before continuing.

2. Read `~/.codex/config.toml`. If a `[mcp_servers.project-home]` block already exists with the
   correct `command` and `args`, do nothing and skip to step 4. Otherwise, back the file up to
   `~/.codex/config.toml.bak.$(date +%s)` and append:

   ```toml
   [mcp_servers.project-home]
   command = "node"
   args = ["<absolute path from step 1>"]
   ```

3. Run `codex mcp list` (path: `/Applications/Codex.app/Contents/Resources/codex` on macOS) and
   confirm `project-home` shows up as `enabled`.

4. Smoke-test the server by running it directly and sending an `initialize` request over stdio
   using newline-delimited JSON (NDJSON). The server must respond with `serverInfo.name = "project-home"`.
   Example one-liner:

   ```bash
   node -e '
     const {spawn}=require("child_process");
     const c=spawn("node",["<path>"]);
     c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05"}})+"\n");
     let out=""; c.stdout.on("data",d=>{out+=d; if(out.includes("project-home")){console.log("OK"); c.kill(); process.exit(0)}});
     setTimeout(()=>{console.log("FAIL",out); c.kill(); process.exit(1)},2000);
   '
   ```

5. Report back with: the path you used, whether the config was already present or newly added,
   the backup filename (if any), and a one-line confirmation that `initialize` returned `OK`.
   Then tell me to fully quit and reopen Codex (Cmd+Q on macOS) so the new MCP is picked up.

If anything fails, stop and show me the exact error rather than guessing. Do not modify any
other section of `config.toml`.
````

After the restart, ask Codex "what MCPs can you see?" — `project_home` should appear in the list.
