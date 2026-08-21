//! pi subagent visualization on the ACP path (ID01-482).
//!
//! pi's `subagents` extension dispatches N child `pi` processes from ONE
//! parent tool call, so the ACP wire (pi-acp) only carries that tool's text
//! updates — the human heartbeat plus machine-readable lifecycle lines the
//! extension emits on purpose (NOTAS-id01-482 §4.1):
//!
//! ```text
//! subagent_spawned: <id> role: <role> model: <model> child_session_id: <id>-<batchKey>
//! subagent_finished: <id> status: completed|failed|interrupted|error
//! ```
//!
//! The children's interior transcripts never ride the wire — they land as
//! pi v3 session JSONL under `<transcript_root>/<child_session_id>/`
//! (the extension's `--session-dir`, retained ≥2.5s past finish so the
//! post-finish drain can read it). The tracker mints ONE chip per spawned
//! line (`{toolCallId}:{id}` — a tab per task, not per batch; the batch's
//! own chip keeps the heartbeat), tails the child's JSONL into tagged
//! [`AgentEvent::Subagent`] events, and settles each chip with a tagged
//! `Done` from the finished line. Every parse fails soft: an unreadable or
//! missing transcript degrades to chip + Done (the extension ships the
//! finished line on the same update as the human progress line, which
//! serves as the fallback output).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use zeron_proto::{AgentEvent, ToolCall};

use crate::HarnessError;

use super::normalize::{OUTPUT_CAP, cap_text};
use super::subagent::{TailFinish, TailReader, done_status, tag};

/// Cadence of the transcript tail (pi appends at message granularity).
const TAIL_POLL: Duration = Duration::from_millis(250);
/// Post-`subagent_finished` drain: the finished line can beat the child's
/// last disk flush, so keep reading briefly before settling the tagged Done.
/// The extension retains the session dir ≥2.5s to cover exactly this.
const DRAIN_POLLS: u32 = 6;
const DRAIN_POLL: Duration = Duration::from_millis(200);

/// The pi subagent transcripts root (`~/.pi/agent/subagent-transcripts`),
/// overridable via `PI_SUBAGENTS_TRANSCRIPT_ROOT`; the test seam reuses the
/// harness's `sessions_root` field.
fn default_transcript_root() -> PathBuf {
    if let Some(root) = std::env::var_os("PI_SUBAGENTS_TRANSCRIPT_ROOT").filter(|s| !s.is_empty()) {
        return PathBuf::from(root);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".pi")
        .join("agent")
        .join("subagent-transcripts")
}

/// A parsed `subagent_spawned:` line. All values are single tokens by
/// construction (task ids are `[A-Za-z0-9._-]+`, models are
/// `provider/model`, child ids `{id}-{batchKey}`).
struct PiSpawn {
    id: String,
    role: String,
    child_session_id: String,
}

fn parse_spawned_line(line: &str) -> Option<PiSpawn> {
    let rest = line.trim().strip_prefix("subagent_spawned:")?;
    let mut toks = rest.split_whitespace();
    let id = toks.next()?.to_owned();
    let mut role = String::new();
    let mut child_session_id = String::new();
    while let Some(tok) = toks.next() {
        let Some(key) = tok.strip_suffix(':') else {
            continue;
        };
        let Some(val) = toks.next() else { break };
        match key {
            "role" => role = val.to_owned(),
            "child_session_id" => child_session_id = val.to_owned(),
            // `model:` rides the line but only informs the extension's own
            // bookkeeping — the chip name keys off id + role.
            _ => {}
        }
    }
    (!id.is_empty() && !child_session_id.is_empty()).then_some(PiSpawn {
        id,
        role,
        child_session_id,
    })
}

/// A parsed `subagent_finished:` line: (task id, status token).
/// Shape: `subagent_finished: <id> status: <token>` — the bare `id`
/// form defaults to `completed`.
fn parse_finished_line(line: &str) -> Option<(String, String)> {
    let rest = line.trim().strip_prefix("subagent_finished:")?;
    let mut toks = rest.split_whitespace();
    let id = toks.next()?.to_owned();
    if id.is_empty() {
        return None;
    }
    let mut status = String::from("completed");
    while let Some(tok) = toks.next() {
        let Some(key) = tok.strip_suffix(':') else {
            continue;
        };
        let Some(val) = toks.next() else { break };
        if key == "status" && !val.is_empty() {
            status = val.to_owned();
        }
    }
    Some((id, status))
}

/// The readable text of one `tool_call`/`tool_call_update`: the ACP content
/// blocks (where pi-acp ships `onUpdate` text) plus `rawOutput.text` for
/// good measure. Both fail soft.
fn update_text(update: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(blocks) = update.get("content").and_then(Value::as_array) {
        for block in blocks {
            if let Some(text) = block
                .get("content")
                .and_then(|b| b.get("text"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                parts.push(text.to_owned());
            }
        }
    }
    if let Some(text) = update
        .get("rawOutput")
        .and_then(|r| r.get("text"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        parts.push(text.to_owned());
    }
    parts.join("\n")
}

/// The last human `subagents:` line of the update carrying the finished
/// line — the chip's fallback doc when no transcript was ever tailed.
fn progress_fallback(text: &str) -> String {
    text.lines()
        .rev()
        .find(|l| {
            let l = l.trim();
            l.starts_with("subagents:") && !l.starts_with("subagent_")
        })
        .map(str::to_owned)
        .unwrap_or_default()
}

fn looks_like_subagents(update: &Value) -> bool {
    if update
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("subagents"))
    {
        return true;
    }
    // Spec §4.2: title *or* rawInput.tasks[] (pi-acp may omit title on
    // later updates; the opening call always carries the schema).
    update
        .get("rawInput")
        .and_then(|r| r.get("tasks"))
        .and_then(Value::as_array)
        .is_some()
}

fn live_key(parent: &str, task_id: &str) -> String {
    format!("{parent}:{task_id}")
}

pub(crate) struct PiTracker {
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
    transcript_root: PathBuf,
    /// toolCallIds recognized as a `subagents` batch (title or rawInput).
    /// Multiple batches can be live; each keeps its own chip namespace.
    parents: HashSet<String>,
    /// `{parent}:{task}` → minted chip id (same string today).
    chips: HashMap<String, String>,
    /// `{parent}:{task}` → finished-signal for the live tail task.
    tails: HashMap<String, oneshot::Sender<TailFinish>>,
    /// `{parent}:{task}` already settled — a replayed spawned line must
    /// not resurrect a chip after the session dir has been delay-rm'd.
    finished: HashSet<String>,
}

impl PiTracker {
    pub(crate) fn new(
        event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
        sessions_root: Option<PathBuf>,
    ) -> Self {
        Self {
            event_tx,
            transcript_root: sessions_root.unwrap_or_else(default_transcript_root),
            parents: HashSet::new(),
            chips: HashMap::new(),
            tails: HashMap::new(),
            finished: HashSet::new(),
        }
    }

    /// Inspect one `session/update` payload's `update` object. Pure
    /// bookkeeping — transcript events flow from the spawned tail tasks,
    /// which hold their own `event_tx` clones (they outlive the turn: the
    /// event stream stays open until every tail settles).
    pub(crate) fn observe(&mut self, update: &Value) {
        if !matches!(
            update.get("sessionUpdate").and_then(Value::as_str),
            Some("tool_call") | Some("tool_call_update")
        ) {
            return;
        }
        let Some(id) = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        if looks_like_subagents(update) {
            self.parents.insert(id.to_owned());
        }
        if !self.parents.contains(id) {
            return;
        }
        let text = update_text(update);
        for line in text.lines() {
            if let Some(spawn) = parse_spawned_line(line) {
                self.handle_spawned(id, spawn);
            } else if let Some((task_id, status)) = parse_finished_line(line) {
                self.handle_finished(id, &task_id, &status, &text);
            }
        }
        // Safety net: if the finished line is lost (cap/truncation) the
        // parent tool's terminal status still settles leftover chips so
        // they never spin for the rest of the session.
        if matches!(
            update.get("status").and_then(Value::as_str),
            Some("completed") | Some("failed") | Some("cancelled") | Some("canceled")
        ) {
            self.settle_parent(id);
        }
    }

    fn handle_spawned(&mut self, parent: &str, spawn: PiSpawn) {
        let key = live_key(parent, &spawn.id);
        if self.finished.contains(&key) || self.chips.contains_key(&key) {
            return;
        }
        let chip_id = key.clone();
        self.chips.insert(key.clone(), chip_id.clone());
        // The minted ToolCall IS the tab. Sent from the SAME task that
        // tails, *before* the poll loop, so a coalesced spawned+finished
        // update cannot deliver Done before the chip exists.
        let role = if spawn.role.is_empty() {
            "subagent".to_owned()
        } else {
            spawn.role.clone()
        };
        let name = format!("Agent: {} ({role})", spawn.id);
        let (finished_tx, finished_rx) = oneshot::channel();
        self.tails.insert(key, finished_tx);
        let event_tx = self.event_tx.clone();
        let root = self.transcript_root.clone();
        let child = spawn.child_session_id;
        tokio::spawn(async move {
            let _ = event_tx
                .send(Ok(AgentEvent::ToolCall {
                    id: chip_id.clone(),
                    call: ToolCall::Unknown { name, input: None },
                }))
                .await;
            pi_tail_task(event_tx, root, child, chip_id, finished_rx).await;
        });
    }

    fn handle_finished(&mut self, parent: &str, id: &str, status: &str, update_text: &str) {
        let key = live_key(parent, id);
        let finish = TailFinish {
            status: done_status(status),
            output: progress_fallback(update_text),
        };
        self.finished.insert(key.clone());
        if let Some(tx) = self.tails.remove(&key) {
            self.chips.remove(&key);
            let _ = tx.send(finish);
        } else if let Some(chip_id) = self.chips.remove(&key) {
            // Defensive: the chip minted but no tail ever started — settle
            // chip-only so it never spins.
            let event_tx = self.event_tx.clone();
            tokio::spawn(async move {
                if !finish.output.is_empty() {
                    let _ = event_tx
                        .send(Ok(tag(
                            &chip_id,
                            AgentEvent::TextDelta {
                                text: finish.output,
                            },
                        )))
                        .await;
                }
                let _ = event_tx
                    .send(Ok(tag(
                        &chip_id,
                        AgentEvent::Done {
                            status: finish.status,
                            result: None,
                            error: None,
                            session_id: None,
                        },
                    )))
                    .await;
            });
        }
        // Neither tail nor chip (e.g. a budget-skip finished line with no
        // spawned line): nothing was minted, nothing to settle.
    }

    fn settle_parent(&mut self, parent: &str) {
        let prefix = format!("{parent}:");
        let leftover: Vec<String> = self
            .tails
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in leftover {
            self.finished.insert(key.clone());
            self.chips.remove(&key);
            if let Some(tx) = self.tails.remove(&key) {
                let _ = tx.send(TailFinish {
                    status: zeron_proto::DoneStatus::Interrupted,
                    output: String::new(),
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Disk tail (pi v3 session JSONL)
// ---------------------------------------------------------------------------

/// The child session's newest `*.jsonl`, located by walking
/// `<root>/<child_session_id>/` recursively (pi writes
/// `<sessionDir>/<encoded-cwd>/<timestamp>.jsonl`; the walk dodges
/// reimplementing the cwd encoding, and the child's cwd can differ from the
/// parent's anyway).
fn locate_pi_transcript(root: &Path, child_session_id: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, best: &mut Option<(std::time::SystemTime, PathBuf)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, best);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                if let Ok(meta) = entry.metadata()
                    && let Ok(mtime) = meta.modified()
                    && best.as_ref().is_none_or(|(t, _)| mtime > *t)
                {
                    *best = Some((mtime, path));
                }
            }
        }
    }
    let mut best = None;
    walk(&root.join(child_session_id), &mut best);
    best.map(|(_, path)| path)
}

/// Map one pi v3 session entry to (untagged) transcript events. Pi writes
/// settled messages whole, so this is message-granularity by construction;
/// the trailing `\n\n` keeps consecutive message-level chunks readable when
/// the fold concatenates them. Unknown entry types skip (fail soft).
fn pi_entry_events(entry: &Value) -> Vec<AgentEvent> {
    if entry.get("type").and_then(Value::as_str) != Some("message") {
        return Vec::new();
    }
    let Some(msg) = entry.get("message") else {
        return Vec::new();
    };
    match msg.get("role").and_then(Value::as_str) {
        Some("assistant") => {
            let mut events = Vec::new();
            for block in msg
                .get("content")
                .and_then(Value::as_array)
                .map(|a| a.as_slice())
                .unwrap_or_default()
            {
                match block.get("type").and_then(Value::as_str) {
                    Some("thinking") => {
                        if let Some(text) = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            events.push(AgentEvent::ReasoningDelta {
                                text: format!("{text}\n\n"),
                            });
                        }
                    }
                    Some("text") => {
                        if let Some(text) = block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            events.push(AgentEvent::TextDelta {
                                text: format!("{text}\n\n"),
                            });
                        }
                    }
                    Some("toolCall") => {
                        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if id.is_empty() || name.is_empty() {
                            continue;
                        }
                        // pi stores `arguments` as a JSON OBJECT (unlike
                        // grok's JSON-encoded string).
                        let args = block.get("arguments").cloned().unwrap_or(Value::Null);
                        events.push(AgentEvent::ToolCall {
                            id: id.to_owned(),
                            call: pi_tool_call(name, &args),
                        });
                    }
                    _ => {}
                }
            }
            events
        }
        Some("toolResult") => {
            let Some(id) = msg
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|i| !i.is_empty())
            else {
                return Vec::new();
            };
            // `content` is string | [{type:"text",text}] — both shapes live.
            let output = match msg.get("content") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Array(blocks)) => {
                    let text: Vec<&str> = blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect();
                    (!text.is_empty()).then(|| text.join("\n"))
                }
                _ => None,
            };
            vec![AgentEvent::ToolResult {
                id: id.to_owned(),
                is_error: msg.get("isError").and_then(Value::as_bool) == Some(true),
                output: output
                    .filter(|t| !t.is_empty())
                    .map(|t| cap_text(&t, OUTPUT_CAP)),
                diff: None,
            }]
        }
        // user prompt / session / model_change / …: not transcript.
        _ => Vec::new(),
    }
}

/// Type a pi-native tool invocation (pi tool names, arguments as object).
fn pi_tool_call(name: &str, args: &Value) -> ToolCall {
    let s = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| args.get(*k))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    match name {
        "bash" => ToolCall::Exec {
            command: s(&["command"]).unwrap_or_default(),
        },
        "read" => ToolCall::ReadFile {
            path: s(&["path", "filePath", "file_path"]).unwrap_or_default(),
        },
        "write" => ToolCall::WriteFile {
            path: s(&["path", "filePath", "file_path"]).unwrap_or_default(),
            content: s(&["content", "contents"]),
        },
        "edit" => ToolCall::EditFile {
            path: s(&["path", "filePath", "file_path"]).unwrap_or_default(),
            old_string: s(&["oldText", "old_string"]),
            new_string: s(&["newText", "new_string"]),
        },
        "grep" | "search" => ToolCall::Search {
            pattern: s(&["pattern"]).unwrap_or_default(),
            path: s(&["path"]),
        },
        "glob" => ToolCall::Glob {
            pattern: s(&["pattern"]).unwrap_or_default(),
        },
        "websearch" => ToolCall::WebSearch {
            query: s(&["query"]).unwrap_or_default(),
        },
        "webfetch" => ToolCall::WebFetch {
            url: s(&["url"]).unwrap_or_default(),
            prompt: None,
        },
        _ => ToolCall::Unknown {
            name: name.to_owned(),
            input: (!args.is_null()).then(|| args.clone()),
        },
    }
}

/// One subagent's transcript tail: poll the child's session JSONL into
/// tagged events until the finished line (or tracker teardown — the dropped
/// oneshot settles Interrupted, grok-tail parity), then drain briefly and
/// settle the chip with a tagged Done. Holds its own `event_tx` clone, so
/// the run's event stream stays open until the tail settles.
async fn pi_tail_task(
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
    root: PathBuf,
    child_session_id: String,
    parent_tool_use_id: String,
    mut finished_rx: oneshot::Receiver<TailFinish>,
) {
    let mut reader: Option<TailReader> = None;
    let mut emitted = false;
    let pump = |reader: &mut Option<TailReader>| -> Vec<AgentEvent> {
        if reader.is_none() {
            *reader = locate_pi_transcript(&root, &child_session_id).map(TailReader::new);
        }
        reader
            .as_mut()
            .map(|r| r.read_new())
            .unwrap_or_default()
            .iter()
            .flat_map(pi_entry_events)
            .collect()
    };

    let finish = loop {
        for ev in pump(&mut reader) {
            emitted = true;
            if event_tx
                .send(Ok(tag(&parent_tool_use_id, ev)))
                .await
                .is_err()
            {
                return;
            }
        }
        if event_tx.is_closed() {
            return;
        }
        tokio::select! {
            fin = &mut finished_rx => {
                // A dropped sender is tracker teardown with the subagent
                // still running: settle the chip as interrupted rather than
                // leaving it spinning forever.
                break fin.unwrap_or(TailFinish {
                    status: zeron_proto::DoneStatus::Interrupted,
                    output: String::new(),
                });
            }
            _ = tokio::time::sleep(TAIL_POLL) => {}
        }
    };

    // The finished line can beat the child's last disk flush: drain until a
    // quiet poll (or the budget), then settle.
    for i in 0..DRAIN_POLLS {
        let events = pump(&mut reader);
        for ev in events.iter().cloned() {
            emitted = true;
            if event_tx
                .send(Ok(tag(&parent_tool_use_id, ev)))
                .await
                .is_err()
            {
                return;
            }
        }
        if events.is_empty() && i > 0 {
            break;
        }
        tokio::time::sleep(DRAIN_POLL).await;
    }
    if !emitted && !finish.output.is_empty() {
        // The tail never found (or never parsed) the transcript: the human
        // progress line from the finished update still makes a useful doc.
        if event_tx
            .send(Ok(tag(
                &parent_tool_use_id,
                AgentEvent::TextDelta {
                    text: finish.output,
                },
            )))
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = event_tx
        .send(Ok(tag(
            &parent_tool_use_id,
            AgentEvent::Done {
                status: finish.status,
                result: None,
                error: None,
                session_id: None,
            },
        )))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zeron_proto::DoneStatus;

    fn tracker_with_root(
        root: Option<PathBuf>,
    ) -> (PiTracker, mpsc::Receiver<Result<AgentEvent, HarnessError>>) {
        let (tx, rx) = mpsc::channel(64);
        (PiTracker::new(tx, root), rx)
    }

    fn subagents_update(tool_call_id: &str, text: &str) -> Value {
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_call_id,
            "title": "subagents",
            "kind": "other",
            "content": [{"type": "content", "content": {"type": "text", "text": text}}],
        })
    }

    #[test]
    fn lifecycle_lines_parse_and_reject_human_heartbeats() {
        let spawn = parse_spawned_line(
            "subagent_spawned: t1 role: research model: alibaba/qwen3.8-max child_session_id: t1-42-77-1",
        )
        .expect("parses");
        assert_eq!(spawn.id, "t1");
        assert_eq!(spawn.role, "research");
        assert_eq!(spawn.child_session_id, "t1-42-77-1");

        assert_eq!(
            parse_finished_line("subagent_finished: t2 status: interrupted"),
            Some(("t2".into(), "interrupted".into()))
        );
        assert_eq!(
            parse_finished_line("subagent_finished: t3"),
            Some(("t3".into(), "completed".into()))
        );

        // Human heartbeats / progress lines never parse as lifecycle.
        for human in [
            "subagents: ⏳ t1 (research·alibaba/qwen3.8-max) 12s — grep",
            "subagents: t1/2 done · exit 0 · 3.1s · cost n/d · alibaba/qwen3.8-max",
            "subagent_spawned:",
            "",
        ] {
            assert!(parse_spawned_line(human).is_none(), "{human}");
            assert!(parse_finished_line(human).is_none(), "{human}");
        }
    }

    #[test]
    fn progress_fallback_picks_the_last_human_line() {
        let text = "subagents: ⏳ t1 — working\nsubagents: t1/1 done · exit 0 · 3.1s\nsubagent_finished: t1 status: completed";
        assert_eq!(
            progress_fallback(text),
            "subagents: t1/1 done · exit 0 · 3.1s"
        );
        assert_eq!(
            progress_fallback("subagent_finished: t1 status: completed"),
            ""
        );
    }

    #[test]
    fn pi_session_entries_map_to_transcript_events() {
        // Real shapes from docs/session-format.md (v3).
        let session = json!({"type": "session", "version": 3, "id": "u1", "cwd": "/tmp"});
        assert!(pi_entry_events(&session).is_empty());

        let user =
            json!({"type": "message", "message": {"role": "user", "content": "Count files."}});
        assert!(pi_entry_events(&user).is_empty());

        let thinking = json!({"type": "message", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "Listing the directory."}
        ]}});
        assert!(matches!(
            pi_entry_events(&thinking).as_slice(),
            [AgentEvent::ReasoningDelta { text }] if text == "Listing the directory.\n\n"
        ));

        let assistant = json!({"type": "message", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "running ls"},
            {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "ls"}}
        ]}});
        assert!(matches!(
            pi_entry_events(&assistant).as_slice(),
            [
                AgentEvent::TextDelta { text },
                AgentEvent::ToolCall { id, call: ToolCall::Exec { command } }
            ] if text == "running ls\n\n" && id == "call-1" && command == "ls"
        ));

        let result_arr = json!({"type": "message", "message": {
            "role": "toolResult", "toolCallId": "call-1", "toolName": "bash",
            "content": [{"type": "text", "text": "a.txt\nb.txt"}], "isError": false
        }});
        assert!(matches!(
            pi_entry_events(&result_arr).as_slice(),
            [AgentEvent::ToolResult { id, is_error: false, output: Some(o), .. }]
                if id == "call-1" && o.contains("a.txt")
        ));

        let result_str = json!({"type": "message", "message": {
            "role": "toolResult", "toolCallId": "call-2", "toolName": "read",
            "content": "plain string", "isError": true
        }});
        assert!(matches!(
            pi_entry_events(&result_str).as_slice(),
            [AgentEvent::ToolResult { id, is_error: true, output: Some(o), .. }]
                if id == "call-2" && o == "plain string"
        ));

        // model_change / thinking_level_change and friends skip.
        for t in ["model_change", "thinking_level_change", "compaction"] {
            assert!(pi_entry_events(&json!({"type": t})).is_empty());
        }
    }

    #[test]
    fn pi_tool_names_type_the_common_calls() {
        let call = pi_tool_call("read", &json!({"path": "/w/a.rs"}));
        assert_eq!(
            call,
            ToolCall::ReadFile {
                path: "/w/a.rs".into()
            }
        );
        let call = pi_tool_call(
            "edit",
            &json!({"path": "/w/a.rs", "oldText": "a", "newText": "b"}),
        );
        assert_eq!(
            call,
            ToolCall::EditFile {
                path: "/w/a.rs".into(),
                old_string: Some("a".into()),
                new_string: Some("b".into()),
            }
        );
        let call = pi_tool_call("grep", &json!({"pattern": "subagent_"}));
        assert_eq!(
            call,
            ToolCall::Search {
                pattern: "subagent_".into(),
                path: None,
            }
        );
        let call = pi_tool_call("mystery", &json!({"x": 1}));
        assert!(matches!(call, ToolCall::Unknown { name, input: Some(_) } if name == "mystery"));
    }

    #[tokio::test]
    async fn spawned_line_mints_chip_and_finished_settles_with_tailed_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        // pi layout: <root>/<child_session_id>/<encoded-cwd>/<ts>.jsonl
        let session_dir = tmp.path().join("t1-42-77-1").join("--tmp--");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("2026-08-19T10-00-00-000.jsonl"),
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"u1\",\"cwd\":\"/tmp\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Listing.\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"two files\"}]}}\n",
            ),
        )
        .unwrap();

        let (mut tracker, mut rx) = tracker_with_root(Some(tmp.path().to_owned()));
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t1 role: research model: alibaba/qwen3.8-max child_session_id: t1-42-77-1",
        ));

        // Chip mint and tail pump are independent tasks — drain until both
        // transcript deltas landed (order vs. the tag-free ToolCall is racy).
        let mut saw_chip = false;
        let mut saw_reasoning = false;
        let mut saw_text = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !(saw_chip && saw_reasoning && saw_text) {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let ev = tokio::time::timeout(left, rx.recv())
                .await
                .expect("chip or tail event")
                .expect("event")
                .expect("ok");
            match ev {
                AgentEvent::ToolCall {
                    id,
                    call: ToolCall::Unknown { name, input: None },
                } if id == "pi1:t1" && name == "Agent: t1 (research)" => {
                    saw_chip = true;
                }
                AgentEvent::Subagent {
                    parent_tool_use_id,
                    event,
                } => {
                    assert_eq!(parent_tool_use_id, "pi1:t1");
                    match *event {
                        AgentEvent::ReasoningDelta { text } => {
                            saw_reasoning = text.starts_with("Listing.");
                        }
                        AgentEvent::TextDelta { text } => {
                            saw_text = text.starts_with("two files");
                        }
                        other => panic!("unexpected tagged event before finish: {other:?}"),
                    }
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }

        // finished settles the chip; a duplicate finished line is a no-op.
        tracker.observe(&subagents_update(
            "pi1",
            "subagents: t1/1 done · exit 0 · 1.4s\nsubagent_finished: t1 status: completed",
        ));
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("settled")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            &ev,
            AgentEvent::Subagent { parent_tool_use_id, event }
                if parent_tool_use_id == "pi1:t1"
                    && matches!(&**event, AgentEvent::Done { status: DoneStatus::Completed, .. })
        ));
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_finished: t1 status: completed",
        ));
    }

    #[tokio::test]
    async fn missing_transcript_degrades_to_progress_line_and_done() {
        let (mut tracker, mut rx) = tracker_with_root(None); // real root: no such child
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t9 role: grunt model: alibaba/qwen3.8-max child_session_id: t9-nope",
        ));
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("chip minted");
        tracker.observe(&subagents_update(
            "pi1",
            "subagents: t9/1 done · exit 3 · 0.2s\nsubagent_finished: t9 status: failed",
        ));
        let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("fallback text")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            &ev,
            AgentEvent::Subagent { parent_tool_use_id, event }
                if parent_tool_use_id == "pi1:t9"
                    && matches!(&**event, AgentEvent::TextDelta { text } if text.contains("t9/1 done"))
        ));
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("done")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            &ev,
            AgentEvent::Subagent { event, .. }
                if matches!(&**event, AgentEvent::Done { status: DoneStatus::Errored, .. })
        ));
    }

    #[tokio::test]
    async fn teardown_settles_open_chips_interrupted() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut tracker, mut rx) = tracker_with_root(Some(tmp.path().to_owned()));
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t1 role: research model: alibaba/qwen3.8-max child_session_id: t1-x",
        ));
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("chip minted");
        drop(tracker); // session end with the subagent still running
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("settles")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            &ev,
            AgentEvent::Subagent { parent_tool_use_id, event }
                if parent_tool_use_id == "pi1:t1"
                    && matches!(&**event, AgentEvent::Done { status: DoneStatus::Interrupted, .. })
        ));
    }

    #[test]
    fn non_subagents_updates_and_foreign_tool_calls_are_ignored() {
        let (mut tracker, mut rx) = tracker_with_root(None);
        // A foreign tool (title ≠ subagents) never becomes the parent batch
        // even if its text happens to contain a spawned line.
        tracker.observe(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "bash-1",
            "title": "bash",
            "content": [{"type": "content", "content": {"type": "text", "text":
                "subagent_spawned: t1 role: grunt model: m child_session_id: t1-x"}}],
        }));
        // …and the heartbeat of an unknown toolCallId parses nothing.
        tracker.observe(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "other",
            "content": [{"type": "content", "content": {"type": "text", "text": "subagent_finished: t1 status: completed"}}],
        }));
        tracker.observe(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}));
        assert!(rx.try_recv().is_err(), "no chips minted, nothing settled");
    }

    #[tokio::test]
    async fn raw_input_tasks_registers_parent_without_title() {
        let (mut tracker, mut rx) = tracker_with_root(None);
        tracker.observe(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "pi-raw",
            "rawInput": {"tasks": [{"id": "t1", "prompt": "x"}]},
            "content": [{"type": "content", "content": {"type": "text", "text":
                "subagent_spawned: t1 role: grunt model: m child_session_id: t1-x"}}],
        }));
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("chip minted")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            ev,
            AgentEvent::ToolCall { id, .. } if id == "pi-raw:t1"
        ));
    }

    #[tokio::test]
    async fn finished_task_is_not_resurrected_by_replayed_spawned_line() {
        let (mut tracker, mut rx) = tracker_with_root(None);
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t1 role: grunt model: m child_session_id: t1-x",
        ));
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("chip");
        tracker.observe(&subagents_update(
            "pi1",
            "subagents: t1/1 done\nsubagent_finished: t1 status: completed",
        ));
        // drain settle (fallback text + Done)
        for _ in 0..4 {
            let _ = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await;
        }
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t1 role: grunt model: m child_session_id: t1-x",
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(150), rx.recv())
                .await
                .is_err(),
            "replayed spawned after finish must not mint again"
        );
    }

    #[tokio::test]
    async fn two_batches_same_task_id_do_not_collide() {
        let (mut tracker, mut rx) = tracker_with_root(None);
        tracker.observe(&subagents_update(
            "batch-a",
            "subagent_spawned: t1 role: research model: m child_session_id: t1-a",
        ));
        tracker.observe(&subagents_update(
            "batch-b",
            "subagent_spawned: t1 role: grunt model: m child_session_id: t1-b",
        ));
        let mut ids = std::collections::HashSet::new();
        for _ in 0..2 {
            let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("chip")
                .expect("event")
                .expect("ok");
            if let AgentEvent::ToolCall { id, .. } = ev {
                ids.insert(id);
            }
        }
        assert!(ids.contains("batch-a:t1") && ids.contains("batch-b:t1"));
    }

    #[tokio::test]
    async fn parent_terminal_status_settles_leftover_chips_interrupted() {
        let (mut tracker, mut rx) = tracker_with_root(None);
        tracker.observe(&subagents_update(
            "pi1",
            "subagent_spawned: t1 role: research model: m child_session_id: t1-lost",
        ));
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("chip");
        // Finished line lost — the parent tool still completes.
        tracker.observe(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "pi1",
            "title": "subagents",
            "status": "completed",
        }));
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("settled")
            .expect("event")
            .expect("ok");
        assert!(matches!(
            ev,
            AgentEvent::Subagent { parent_tool_use_id, event }
                if parent_tool_use_id == "pi1:t1"
                    && matches!(*event, AgentEvent::Done { status: DoneStatus::Interrupted, .. })
        ));
    }
}
