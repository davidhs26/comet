//! Subagent transcript sidecars — reading a Task tool call's inner activity
//! back from the harness's own on-disk session store.
//!
//! Claude Code persists every subagent's full transcript next to the parent
//! session file: `{config_dir}/projects/{slug(cwd)}/{sessionId}/subagents/`
//! holds an `agent-{id}.jsonl` transcript plus an `agent-{id}.meta.json`
//! carrying the parent Task call's `toolUseId` — the same id comet stores on
//! the doc's tool part. Comet never writes here; this is a read-only view
//! served over the `SubagentTranscript` RPC from the chat's host device.

use std::path::{Path, PathBuf};

use zeron_proto::{SubagentEntry, SubagentTranscript, TodoItem, ToolCall};
use serde_json::Value;

/// Claude's config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude` (same resolution
/// as [`crate::agent_accounts::AgentAccountsConfig::detect`]).
pub fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::repos::home_dir().join(".claude"))
}

/// Entry cap per transcript — bounds the RPC payload; the tail is counted.
const MAX_ENTRIES: usize = 500;
/// Per-text-entry char cap. Sized off the real store: the largest final
/// reports observed run ~44k chars, and the report is the whole payoff of
/// expanding a subagent — a 16k cap visibly cut them mid-sentence.
const MAX_TEXT_CHARS: usize = 64 * 1024;

/// Claude Code's project-dir slug: every non-alphanumeric byte of the session
/// cwd becomes `-` (`/Users/x/.dir` → `-Users-x--dir`).
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Locate the sidecar transcript for `tool_call_id` under one project's
/// session dirs. Scans every session's `subagents/*.meta.json` rather than
/// trusting a remembered session id: resumes re-mint the session UUID, but
/// the sidecar stays filed under the id that was live when the Task ran.
fn find_sidecar(projects_dir: &Path, cwd: &str, tool_call_id: &str) -> Option<(PathBuf, Value)> {
    let project = projects_dir.join(project_slug(cwd));
    let sessions = std::fs::read_dir(&project).ok()?;
    for session in sessions.flatten() {
        // The project dir holds the session dirs AND the sibling
        // `{sessionId}.jsonl` transcripts; only the former can carry sidecars.
        if !session.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let subagents = session.path().join("subagents");
        let Ok(metas) = std::fs::read_dir(&subagents) else {
            continue;
        };
        for meta_entry in metas.flatten() {
            let meta_path = meta_entry.path();
            if meta_path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(meta) = std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            else {
                continue;
            };
            if meta.get("toolUseId").and_then(Value::as_str) != Some(tool_call_id) {
                continue;
            }
            // agent-{id}.meta.json → agent-{id}.jsonl. A matching id on a file
            // that isn't `*.meta.json` keeps the scan going — it must not end
            // the search for every remaining session.
            let Some(stem) = meta_path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".meta.json"))
            else {
                continue;
            };
            return Some((subagents.join(format!("{stem}.jsonl")), meta));
        }
    }
    None
}

/// Read the subagent transcript behind a Task tool call, or `None` when no
/// sidecar exists (non-Claude harness, cleaned store, or foreign device).
pub fn claude_subagent_transcript(
    config_dir: &Path,
    cwd: &str,
    tool_call_id: &str,
) -> std::io::Result<Option<SubagentTranscript>> {
    let Some((jsonl, meta)) = find_sidecar(&config_dir.join("projects"), cwd, tool_call_id) else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(&jsonl)?;
    let mut entries = Vec::new();
    let mut truncated_entries = 0usize;
    let mut push = |entry: SubagentEntry| {
        if entries.len() < MAX_ENTRIES {
            entries.push(entry);
        } else {
            truncated_entries += 1;
        }
    };
    for line in raw.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = row
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        // One Text entry per assistant message; tool_use blocks stay ordered.
        let mut text = String::new();
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        let t = t.trim();
                        if !t.is_empty() {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(t);
                        }
                    }
                }
                Some("tool_use") => {
                    if !text.is_empty() {
                        push(SubagentEntry::Text {
                            text: cap_text(std::mem::take(&mut text)),
                        });
                    }
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    let input = block.get("input").unwrap_or(&Value::Null);
                    push(SubagentEntry::Tool {
                        call: native_tool_call(name, input),
                    });
                }
                _ => {}
            }
        }
        if !text.is_empty() {
            push(SubagentEntry::Text {
                text: cap_text(text),
            });
        }
    }
    Ok(Some(SubagentTranscript {
        agent_type: meta
            .get("agentType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        description: meta
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        entries,
        truncated_entries,
    }))
}

fn cap_text(text: String) -> String {
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text;
    }
    let mut capped: String = text.chars().take(MAX_TEXT_CHARS).collect();
    capped.push('…');
    capped
}

/// Map a Claude-native tool_use (SDK names + input shapes, not ACP) to the
/// typed [`ToolCall`] the transcript renders. Inputs are reduced to the same
/// fields the render-parts policy would keep — no prompts, no file contents.
fn native_tool_call(name: &str, input: &Value) -> ToolCall {
    let s = |key: &str| -> Option<String> {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    match name {
        "Bash" => ToolCall::Exec {
            command: s("command").unwrap_or_default(),
        },
        "Read" | "NotebookRead" => ToolCall::ReadFile {
            path: s("file_path")
                .or_else(|| s("notebook_path"))
                .unwrap_or_default(),
        },
        "Write" => ToolCall::WriteFile {
            path: s("file_path").unwrap_or_default(),
            content: None,
        },
        "Edit" | "MultiEdit" | "NotebookEdit" => ToolCall::EditFile {
            path: s("file_path")
                .or_else(|| s("notebook_path"))
                .unwrap_or_default(),
            old_string: None,
            new_string: None,
        },
        "Grep" => ToolCall::Search {
            pattern: s("pattern").unwrap_or_default(),
            path: s("path"),
        },
        "Glob" => ToolCall::Glob {
            pattern: s("pattern").unwrap_or_default(),
        },
        "WebFetch" => ToolCall::WebFetch {
            url: s("url").unwrap_or_default(),
            prompt: None,
        },
        "WebSearch" => ToolCall::WebSearch {
            query: s("query").unwrap_or_default(),
        },
        "TodoWrite" => ToolCall::Todo {
            items: input
                .get("todos")
                .and_then(Value::as_array)
                .map(|todos| {
                    todos
                        .iter()
                        .filter_map(|t| {
                            Some(TodoItem {
                                text: t.get("content")?.as_str()?.to_owned(),
                                done: t.get("status").and_then(Value::as_str) == Some("completed"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "Task" | "Agent" => ToolCall::Task {
            description: s("description").unwrap_or_default(),
            agent_type: s("subagent_type"),
            prompt: None,
        },
        _ => match name.strip_prefix("mcp__").map(|rest| rest.splitn(2, "__")) {
            Some(mut parts) => {
                let server = parts.next().unwrap_or_default().to_owned();
                let tool = parts.next().unwrap_or(name).to_owned();
                ToolCall::Mcp {
                    server,
                    tool,
                    input: None,
                }
            }
            None => ToolCall::Unknown {
                name: name.to_owned(),
                input: None,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_claude_code() {
        assert_eq!(
            project_slug("/Users/sina/fun/comet"),
            "-Users-sina-fun-comet"
        );
        assert_eq!(
            project_slug("/Users/sina/.zeron/worktrees/zeron-quiet-comet"),
            "-Users-sina--zeron-worktrees-zeron-quiet-comet"
        );
    }

    #[test]
    fn native_calls_reduce_to_typed_variants() {
        assert_eq!(
            native_tool_call(
                "Bash",
                &serde_json::json!({"command": "ls", "description": "x"})
            ),
            ToolCall::Exec {
                command: "ls".into()
            }
        );
        assert_eq!(
            native_tool_call(
                "Grep",
                &serde_json::json!({"pattern": "foo", "path": "src"})
            ),
            ToolCall::Search {
                pattern: "foo".into(),
                path: Some("src".into())
            }
        );
        assert_eq!(
            native_tool_call("mcp__linear__create_issue", &Value::Null),
            ToolCall::Mcp {
                server: "linear".into(),
                tool: "create_issue".into(),
                input: None
            }
        );
        assert_eq!(
            native_tool_call("Skill", &serde_json::json!({"skill": "run"})),
            ToolCall::Unknown {
                name: "Skill".into(),
                input: None
            }
        );
    }

    fn write_fixture(root: &Path, cwd: &str, session: &str, agent: &str, tool_use_id: &str) {
        let dir = root
            .join("projects")
            .join(project_slug(cwd))
            .join(session)
            .join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("agent-{agent}.meta.json")),
            serde_json::json!({
                "agentType": "Explore",
                "description": "Map the repo",
                "toolUseId": tool_use_id,
                "spawnDepth": 1,
            })
            .to_string(),
        )
        .unwrap();
        // Real shape: ONE content block per row (a single reply is split
        // across rows sharing `message.id`), `thinking` blocks interleaved,
        // and `attachment` rows between them.
        let lines = [
            serde_json::json!({"type": "user", "message": {"role": "user", "content": "prompt"}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m1", "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
            ]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m1", "content": [
                {"type": "text", "text": "Scanning the crates."},
            ]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m1", "content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls crates"}},
            ]}}),
            serde_json::json!({"type": "attachment", "subtype": "skill_listing"}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m1", "content": [
                {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/a/b.rs"}},
            ]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m2", "content": [
                {"type": "text", "text": "Done."},
            ]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "id": "m2", "content": [
                {"type": "text", "text": "Report body."},
            ]}}),
        ];
        let body: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        std::fs::write(dir.join(format!("agent-{agent}.jsonl")), body.join("\n")).unwrap();
    }

    #[test]
    fn reads_transcript_by_tool_use_id_across_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = "/tmp/proj";
        write_fixture(tmp.path(), cwd, "session-a", "aaa", "toolu_other");
        write_fixture(tmp.path(), cwd, "session-b", "bbb", "toolu_match");

        let got = claude_subagent_transcript(tmp.path(), cwd, "toolu_match")
            .unwrap()
            .expect("sidecar found");
        assert_eq!(got.agent_type.as_deref(), Some("Explore"));
        assert_eq!(got.description.as_deref(), Some("Map the repo"));
        assert_eq!(got.truncated_entries, 0);
        assert_eq!(
            got.entries,
            vec![
                SubagentEntry::Text {
                    text: "Scanning the crates.".into()
                },
                SubagentEntry::Tool {
                    call: ToolCall::Exec {
                        command: "ls crates".into()
                    }
                },
                SubagentEntry::Tool {
                    call: ToolCall::ReadFile {
                        path: "/a/b.rs".into()
                    }
                },
                // One-block-per-row means a split reply stays two entries;
                // the renderer joins them with a single blank line.
                SubagentEntry::Text {
                    text: "Done.".into()
                },
                SubagentEntry::Text {
                    text: "Report body.".into()
                },
            ]
        );

        assert!(
            claude_subagent_transcript(tmp.path(), cwd, "toolu_missing")
                .unwrap()
                .is_none()
        );
        assert!(
            claude_subagent_transcript(tmp.path(), "/elsewhere", "toolu_match")
                .unwrap()
                .is_none()
        );
    }

    /// Nested subagents (spawnDepth 2–3) are filed FLAT beside their ancestors
    /// under the root session's dir, with an extra `parentAgentId`. Keying the
    /// scan on the globally-unique `toolUseId` resolves them with no special
    /// case — a nested Agent chip drills in exactly like a top-level one.
    #[test]
    fn resolves_a_nested_subagent_filed_beside_its_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = "/tmp/proj";
        write_fixture(tmp.path(), cwd, "root-session", "parent", "toolu_parent");
        let dir = tmp
            .path()
            .join("projects")
            .join(project_slug(cwd))
            .join("root-session")
            .join("subagents");
        std::fs::write(
            dir.join("agent-child.meta.json"),
            serde_json::json!({
                "agentType": "general-purpose",
                "description": "Nested probe",
                "toolUseId": "toolu_child",
                "parentAgentId": "parent",
                "spawnDepth": 2,
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("agent-child.jsonl"),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "n1", "name": "Agent",
                 "input": {"description": "deeper", "subagent_type": "Explore", "prompt": "secret"}},
            ]}})
            .to_string(),
        )
        .unwrap();

        let got = claude_subagent_transcript(tmp.path(), cwd, "toolu_child")
            .unwrap()
            .expect("nested sidecar found");
        assert_eq!(got.description.as_deref(), Some("Nested probe"));
        assert_eq!(
            got.entries,
            // The nested spawn keeps its own Task chip — and the prompt never
            // leaves the host (same policy as the doc's render parts).
            vec![SubagentEntry::Tool {
                call: ToolCall::Task {
                    description: "deeper".into(),
                    agent_type: Some("Explore".into()),
                    prompt: None,
                }
            }]
        );
        // The parent still resolves from the same directory.
        assert!(
            claude_subagent_transcript(tmp.path(), cwd, "toolu_parent")
                .unwrap()
                .is_some()
        );
    }
}
