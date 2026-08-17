//! pi-adopt — surface pi harness sessions created OUTSIDE this engine (CLI
//! runs, `pi -p` workers) as regular workspace chats, so every client (iOS
//! included) can list and open them.
//!
//! Discovery reads two sources and merges them (dedup by pi sessionId):
//!
//! 1. the pi-acp session map — `$HOME/.pi/pi-acp/session-map.json`;
//! 2. the pi agent session store — `$HOME/.pi/agent/sessions/*/*.jsonl`
//!    (one level of subdirs). Sessions that never went through pi-acp (plain
//!    CLI runs) live ONLY here, so the directory walk is mandatory.
//!
//! Each adopted session becomes one `Chat` row owned by THIS device with a
//! deterministic UUIDv5 id (same pi session → same chat id on every scan), a
//! resolved/created `space_id` (clients skip chats without a live space), and
//! an idle `Session` row. Rows are written ONLY when new — existing rows are
//! never rewritten, so the oplog CRDT stays clean.
//!
//! The whole module is best-effort: any read/parse failure is logged and
//! skipped, never propagated — adoption must not take the engine down.
//!
//! The noise filters below only stop NEW adoptions; they never delete rows.
//! Historical cleanup of chats adopted before a filter existed (e.g. legacy
//! /tmp sessions) is an operator task (`~/zeron-purge.mjs` via IPC `Mutate
//! deleteChat`), not something this filter does.
//!
//! Feature flag: `ZERON_ADOPT_PI_SESSIONS=1` (any other value or absent =
//! off, silently — zero logs, zero tasks when off).

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use zeron_proto::{Chat, ChatConfig, HarnessId, SandboxLevel, Session, SessionStatus};

use crate::workspace_host::WorkspaceHost;

/// Rescan cadence.
const SCAN_INTERVAL: Duration = Duration::from_secs(45);
/// Feature flag env var; exactly `1` enables adoption.
const FLAG_ENV: &str = "ZERON_ADOPT_PI_SESSIONS";
/// Optional overrides for the discovery paths (tests / local experiments).
const MAP_PATH_ENV: &str = "ZERON_PI_SESSION_MAP";
const SESSIONS_DIR_ENV: &str = "ZERON_PI_SESSIONS_DIR";
/// Fixed UUIDv5 namespace: deterministic chat + space ids across scans.
const PI_ADOPT_NAMESPACE: &str = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
/// Title cap: 60 chars total, `…` included.
const TITLE_MAX_CHARS: usize = 60;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Running adoption loop (present only while the feature flag is on).
pub struct PiAdopt {
    cancel: CancellationToken,
    /// Loop task — taken + awaited on shutdown.
    supervisor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PiAdopt {
    /// Start the adoption loop unless the feature flag is off. `None` (and no
    /// logs, no tasks) when disabled.
    pub fn start(workspace: WorkspaceHost) -> Option<Self> {
        if !flag_enabled() {
            return None;
        }
        tracing::info!(
            interval_secs = SCAN_INTERVAL.as_secs(),
            "pi-adopt: loop started"
        );
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            loop {
                // Directory walk + JSONL reads are sync IO — keep them off
                // the runtime worker so a large session store cannot stall
                // other engine tasks (or make shutdown wait on a blocked worker).
                let ws = workspace.clone();
                let map = default_session_map_path();
                let dir = default_sessions_dir();
                let _ = tokio::task::spawn_blocking(move || adopt_once(&ws, &map, &dir)).await;
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(SCAN_INTERVAL) => {}
                }
            }
        });
        Some(Self {
            cancel,
            supervisor: Mutex::new(Some(task)),
        })
    }

    /// Cancel the loop and wait for it to exit. Idempotent.
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        let task = lock(&self.supervisor).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// One adoption pass over both discovery sources. Pure function of the two
/// paths + current workspace state; every failure is logged and skipped.
pub fn adopt_once(workspace: &WorkspaceHost, map_path: &Path, sessions_dir: &Path) {
    let namespace = match uuid::Uuid::parse_str(PI_ADOPT_NAMESPACE) {
        Ok(ns) => ns,
        Err(err) => {
            tracing::error!(error = %err, "pi-adopt: invalid namespace UUID, adoption disabled");
            return;
        }
    };
    for entry in discover_sessions(map_path, sessions_dir) {
        adopt_session(workspace, &namespace, &entry);
    }
}

// ── discovery ──────────────────────────────────────────────────────────────

/// A pi session candidate from either source.
#[derive(Debug, Clone)]
struct PiSession {
    session_id: String,
    cwd: String,
    /// JSONL transcript; `None` when only the map knows about the session.
    session_file: Option<PathBuf>,
    /// `updatedAt` from the map (RFC3339), when present.
    updated_at: Option<DateTime<Utc>>,
}

/// Entry shape of pi-acp's session-map.json.
#[derive(Debug, Clone, Deserialize)]
struct PiSessionEntry {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "sessionFile")]
    session_file: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct SessionMap {
    #[serde(default)]
    #[allow(dead_code)]
    version: u32,
    sessions: std::collections::HashMap<String, PiSessionEntry>,
}

/// Map first (warn + continue on any failure), then the sessions dir as a
/// fallback; dir sessions dedup against map session ids.
fn discover_sessions(map_path: &Path, sessions_dir: &Path) -> Vec<PiSession> {
    let mut sessions = Vec::new();
    match read_session_map(map_path) {
        Ok(map) => sessions.extend(map),
        Err(err) => {
            // Missing / unreadable / corrupt map is expected on machines that
            // never ran pi-acp — and this fires every scan, so warn would spam
            // every 45s forever. debug: dir fallback below still covers it.
            tracing::debug!(map = %map_path.display(), error = %err, "pi-adopt: session map unreadable");
        }
    }
    let known: std::collections::HashSet<String> =
        sessions.iter().map(|s| s.session_id.clone()).collect();
    for found in scan_sessions_dir(sessions_dir) {
        if !known.contains(found.session_id.as_str()) {
            sessions.push(found);
        }
    }
    sessions
}

fn read_session_map(map_path: &Path) -> Result<Vec<PiSession>, String> {
    let data = std::fs::read_to_string(map_path).map_err(|e| e.to_string())?;
    let map: SessionMap = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(map
        .sessions
        .into_values()
        .filter_map(|entry| {
            let updated_at = entry.updated_at.parse().ok();
            Some(PiSession {
                session_id: entry.session_id,
                cwd: entry.cwd,
                session_file: Some(PathBuf::from(entry.session_file)),
                updated_at,
            })
        })
        .collect())
}

/// Walk `dir/*/*.jsonl` (one level of subdirs): session id/cwd come from the
/// first `type:"session"` line, falling back to the `{ts}_{id}.jsonl`
/// filename for the id. Timestamps default to the file mtime.
fn scan_sessions_dir(dir: &Path) -> Vec<PiSession> {
    let mut out = Vec::new();
    let Ok(subdirs) = std::fs::read_dir(dir) else {
        return out; // absent store: nothing to walk
    };
    for subdir in subdirs.flatten() {
        if !subdir.path().is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(subdir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let scan = scan_jsonl(&path);
            let session_id = scan
                .as_ref()
                .and_then(|s| s.session_id.clone())
                .or_else(|| session_id_from_filename(&path))
                .unwrap_or_default();
            let cwd = scan
                .as_ref()
                .and_then(|s| s.cwd.clone())
                .unwrap_or_default();
            let updated_at = mtime(&path).or_else(|| scan.as_ref().and_then(|s| s.timestamp));
            out.push(PiSession {
                session_id,
                cwd,
                session_file: Some(path),
                updated_at,
            });
        }
    }
    out
}

/// What a single JSONL transcript yields for adoption.
#[derive(Debug, Default)]
struct JsonlScan {
    /// From the first line when it is `type:"session"`.
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<DateTime<Utc>>,
    /// First non-empty text block of a user message.
    first_user_text: Option<String>,
}

/// Scan a transcript: header line + first user message. `None` when the file
/// cannot be opened; short or malformed lines are skipped, never fatal.
fn scan_jsonl(path: &Path) -> Option<JsonlScan> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) => {
            tracing::debug!(file = %path.display(), error = %err, "pi-adopt: cannot open session file");
            return None;
        }
    };
    let mut scan = JsonlScan::default();
    let mut first_line = true;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let at_header = std::mem::replace(&mut first_line, false);
        if line.is_empty() {
            continue; // a leading blank still consumed the header slot
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let kind = value.get("type").and_then(|t| t.as_str());
        if at_header && kind == Some("session") {
            scan.session_id = value.get("id").and_then(|v| v.as_str()).map(str::to_owned);
            scan.cwd = value.get("cwd").and_then(|v| v.as_str()).map(str::to_owned);
            scan.timestamp = value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|t| t.parse().ok());
        }
        if scan.first_user_text.is_none()
            && kind == Some("message")
            && value
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(|r| r.as_str())
                == Some("user")
        {
            let text = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|blocks| {
                    blocks
                        .iter()
                        .find_map(|b| b.get("text").and_then(|t| t.as_str()))
                })
                .map(str::trim);
            if let Some(text) = text {
                if !text.is_empty() {
                    scan.first_user_text = Some(text.to_owned());
                }
            }
        }
        if scan.first_user_text.is_some() {
            break; // first user text is all adoption needs from the file
        }
    }
    Some(scan)
}

/// `2026-08-16T22-20-38-442Z_{id}.jsonl` → `{id}`.
fn session_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let (_, id) = stem.rsplit_once('_')?;
    (!id.is_empty()).then(|| id.to_owned())
}

fn mtime(path: &Path) -> Option<DateTime<Utc>> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified))
}

// ── adoption ───────────────────────────────────────────────────────────────

/// Deterministic chat id for a pi session id.
fn chat_id_for(namespace: &uuid::Uuid, session_id: &str) -> String {
    uuid::Uuid::new_v5(namespace, session_id.as_bytes()).to_string()
}

/// Ephemeral working directories whose sessions are never worth listing
/// (test workspaces, scratch dirs) - they churn constantly and are not chats.
fn is_ephemeral_cwd(cwd: &str) -> bool {
    let p = cwd.trim_end_matches('/');
    p == "/tmp"
        || p.starts_with("/tmp/")
        || p == "/var/tmp"
        || p.starts_with("/var/tmp/")
        || p == "/private/tmp"
        || p.starts_with("/private/tmp/")
        || p == "/private/var/tmp" // macOS symlink target of /var/tmp
        || p.starts_with("/private/var/tmp/")
}

/// Machine-to-machine utility prompts (title generation and similar) that
/// produce pi sessions but are not conversations anyone wants listed. The
/// title prefix is owned by `titles::TITLE_PROMPT_PREFIX` so the titling
/// prompt and this filter cannot drift apart.
const UTILITY_PROMPT_PREFIXES: &[&str] = &[crate::titles::TITLE_PROMPT_PREFIX];

fn is_utility_prompt(first_user_text: &str) -> bool {
    let t = first_user_text.trim_start();
    UTILITY_PROMPT_PREFIXES.iter().any(|p| t.starts_with(p))
}

/// Adopt one session: skip silently when already known, empty, or malformed.
fn adopt_session(workspace: &WorkspaceHost, namespace: &uuid::Uuid, entry: &PiSession) {
    if entry.session_id.is_empty() || entry.cwd.is_empty() {
        tracing::debug!(
            file = ?entry.session_file,
            "pi-adopt: skip session with empty id or cwd"
        );
        return;
    }
    // Noise filter: ephemeral workdirs are never worth listing.
    if is_ephemeral_cwd(&entry.cwd) {
        tracing::debug!(
            pi_session = %entry.session_id,
            cwd = %entry.cwd,
            "pi-adopt: skip session in ephemeral cwd"
        );
        return;
    }
    let chat_id = chat_id_for(namespace, &entry.session_id);
    let chats = match workspace.read_chats() {
        Ok(chats) => chats,
        Err(err) => {
            tracing::warn!(error = %err, "pi-adopt: read_chats failed");
            return;
        }
    };
    // Deterministic id already present (this or any other device), or this
    // device already hosts the session under a different id → nothing to do.
    if chats.iter().any(|c| c.id == chat_id) {
        return;
    }
    let device_id = workspace.device_id();
    if chats.iter().any(|c| {
        c.device_id == device_id
            && c.harness_session_id.as_deref() == Some(entry.session_id.as_str())
    }) {
        return;
    }
    // Transcript must exist and hold at least one user message — sessions
    // with no user turn (or unreadable transcripts) are not chats worth
    // listing.
    let Some(scan) = entry.session_file.as_deref().and_then(scan_jsonl) else {
        tracing::debug!(
            pi_session = %entry.session_id,
            file = ?entry.session_file,
            "pi-adopt: skip session with unreadable transcript"
        );
        return;
    };
    let Some(user_text) = scan.first_user_text.as_deref() else {
        tracing::debug!(
            pi_session = %entry.session_id,
            file = ?entry.session_file,
            "pi-adopt: skip session with no user message"
        );
        return;
    };

    // Noise filter: internal utility prompts (e.g. the title generator) are
    // machine-to-machine calls, not conversations.
    if is_utility_prompt(user_text) {
        tracing::info!(
            pi_session = %entry.session_id,
            "pi-adopt: skip utility-prompt session"
        );
        return;
    }

    let title = extract_title(Some(user_text), &entry.cwd);
    let updated_at = entry
        .updated_at
        .or_else(|| entry.session_file.as_deref().and_then(mtime))
        .or_else(|| scan.timestamp)
        .unwrap_or_else(Utc::now);
    // Space is mandatory — chats without a space are invisible in the UI.
    // If resolution fails (transient create_space error), skip adoption
    // and retry on the next scan; never adopt with a None space.
    let Some(space_id) = resolve_space(workspace, device_id, &entry.cwd, namespace) else {
        return;
    };

    let chat = Chat {
        id: chat_id.clone(),
        device_id: device_id.to_owned(),
        title: Some(title.clone()),
        archived: false,
        cwd: Some(entry.cwd.clone()),
        branch: None,
        checkout_id: None,
        config: Some(ChatConfig {
            harness: HarnessId::Pi,
            model: None,
            reasoning: None,
            model_options: serde_json::Map::new(),
            sandbox: SandboxLevel::WorkspaceWrite,
        }),
        last_message_preview: Some(title.clone()),
        last_message_at: Some(updated_at),
        created_at: updated_at,
        harness_session_id: Some(entry.session_id.clone()),
        harness_session_cwd: Some(entry.cwd.clone()),
        space_id: Some(space_id),
        last_seen_at: None,
        room_gen: Some(2),
    };
    if let Err(err) = workspace.import_chat_row(&chat) {
        tracing::warn!(chat = %chat_id, error = %err, "pi-adopt: chat row write failed");
        return;
    }
    workspace.record_session(&Session {
        chat_id: chat_id.clone(),
        device_id: device_id.to_owned(),
        status: SessionStatus::Idle,
        started_at: None,
        updated_at,
    });
    tracing::info!(
        chat = %chat_id,
        pi_session = %entry.session_id,
        cwd = %entry.cwd,
        title = %title,
        "pi-adopt: adopted pi session"
    );
}

/// Title: the user text capped at 60 chars (UTF-8 safe), or the cwd basename
/// when no text is available.
fn extract_title(user_text: Option<&str>, cwd: &str) -> String {
    match user_text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => {
            if text.chars().count() > TITLE_MAX_CHARS {
                let cut: String = text.chars().take(TITLE_MAX_CHARS - 1).collect();
                format!("{cut}…")
            } else {
                text.to_owned()
            }
        }
        None => basename(cwd),
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_owned()
}

/// Attach the chat to a space of THIS device: exact path match, else the
/// longest owned path that is a path-boundary prefix of the cwd, else create
/// one (idempotent — re-read to pick up a pre-existing duplicate row's id).
fn resolve_space(
    workspace: &WorkspaceHost,
    device_id: &str,
    cwd: &str,
    namespace: &uuid::Uuid,
) -> Option<String> {
    let spaces = match workspace.read_spaces() {
        Ok(spaces) => spaces,
        Err(err) => {
            tracing::warn!(error = %err, "pi-adopt: read_spaces failed");
            return None;
        }
    };
    let owned: Vec<&zeron_proto::Space> =
        spaces.iter().filter(|s| s.device_id == device_id).collect();
    if let Some(exact) = owned.iter().find(|s| s.path == cwd) {
        return Some(exact.id.clone());
    }
    if let Some(prefix) = owned
        .iter()
        .filter(|s| is_path_prefix(&s.path, cwd))
        .max_by_key(|s| s.path.len())
    {
        return Some(prefix.id.clone());
    }
    let name = basename(cwd);
    let space_id =
        uuid::Uuid::new_v5(namespace, format!("space:{device_id}\x00{cwd}").as_bytes()).to_string();
    if let Err(err) = workspace.create_space(&space_id, device_id, cwd, Some(name), false) {
        tracing::warn!(space = %space_id, error = %err, "pi-adopt: create_space failed");
        return None;
    }
    // create_space no-ops when another id already owns (device, path): use
    // the row's real id, not the one we derived. If the re-read fails or
    // the row is still missing, skip — a guessed id would dangle and the
    // orphan sweep would delete the chat on the next tick.
    match workspace.read_spaces() {
        Ok(spaces) => spaces
            .iter()
            .find(|s| s.device_id == device_id && s.path == cwd)
            .map(|s| s.id.clone())
            .or_else(|| {
                tracing::warn!(
                    space = %space_id,
                    cwd,
                    "pi-adopt: space row missing after create; skip until next scan"
                );
                None
            }),
        Err(err) => {
            tracing::warn!(error = %err, "pi-adopt: re-read spaces after create failed");
            None
        }
    }
}

/// `is_path_prefix("/a", "/a/b")` — the boundary keeps `/a` from matching
/// `/ab`.
fn is_path_prefix(prefix: &str, path: &str) -> bool {
    if prefix == "/" {
        return path.starts_with('/'); // root prefixes every absolute path
    }
    path.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

// ── env plumbing ───────────────────────────────────────────────────────────

fn flag_enabled() -> bool {
    std::env::var_os(FLAG_ENV).is_some_and(|v| v == "1")
}

fn default_session_map_path() -> PathBuf {
    std::env::var_os(MAP_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".pi/pi-acp/session-map.json"))
}

fn default_sessions_dir() -> PathBuf {
    std::env::var_os(SESSIONS_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".pi/agent/sessions"))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_id_is_stable_and_distinct() {
        let ns = uuid::Uuid::parse_str(PI_ADOPT_NAMESPACE).expect("namespace parses");
        let a1 = chat_id_for(&ns, "session-a");
        let a2 = chat_id_for(&ns, "session-a");
        assert_eq!(a1, a2, "same pi session must map to the same chat id");
        assert_ne!(a1, chat_id_for(&ns, "session-b"));
        assert!(uuid::Uuid::parse_str(&a1).is_ok());
    }

    #[test]
    fn title_truncation_is_utf8_safe() {
        // Multibyte: 100 × 'é' → 59 chars + ellipsis = 60 chars, still valid.
        let long = "é".repeat(100);
        let title = extract_title(Some(&long), "/tmp/x");
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
        // ASCII: 70 chars → 59 + '…'.
        let ascii = "a".repeat(70);
        let title = extract_title(Some(&ascii), "/tmp/x");
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(title.chars().filter(|c| *c == 'a').count(), 59);
        // Short stays untouched; whitespace is trimmed.
        assert_eq!(extract_title(Some("  hola  "), "/tmp/x"), "hola");
        // No user text → cwd basename fallback.
        assert_eq!(extract_title(None, "/tmp/factory"), "factory");
        assert_eq!(extract_title(Some("   "), "/tmp/factory"), "factory");
    }

    #[test]
    fn ephemeral_cwd_is_noise() {
        assert!(is_ephemeral_cwd("/tmp"));
        assert!(is_ephemeral_cwd("/tmp/"));
        assert!(is_ephemeral_cwd("/tmp/pw2-e2e-x/workspaces/j1"));
        assert!(is_ephemeral_cwd("/var/tmp/x"));
        assert!(is_ephemeral_cwd("/private/tmp/x"));
        assert!(is_ephemeral_cwd("/private/var/tmp/x"));
        assert!(!is_ephemeral_cwd("/home/david/tmpwork"));
        assert!(!is_ephemeral_cwd("/home/david/factory"));
    }

    #[test]
    fn utility_prompts_are_noise() {
        assert!(is_utility_prompt(
            "Reply with ONLY a concise 3-5 word title in Title Case (no quotes)"
        ));
        assert!(is_utility_prompt("  Reply with ONLY a concise title"));
        assert!(!is_utility_prompt("Sos la sesion de prueba PW1"));
    }

    #[test]
    fn utility_prefix_matches_the_real_titling_prompt() {
        // The filter must keep matching the prompt `titles.rs` actually sends:
        // both sides are built from the same constant.
        let real_prompt = format!(
            "{} 3-5 word title in Title Case (no quotes, no punctuation) \
             for a coding session that begins with this request:\n\nfix the bug",
            crate::titles::TITLE_PROMPT_PREFIX
        );
        assert!(is_utility_prompt(&real_prompt));
    }

    #[test]
    fn scan_skips_session_without_user_message() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","id":"sid","cwd":"/tmp","timestamp":"2026-08-16T22:20:38.442Z"}"#,
                "\n",
                r#"{"type":"model_change","id":"m1","parentId":null}"#,
                "\n",
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hola"}]}}"#,
                "\n",
            ),
        )
        .expect("write jsonl");
        let scan = scan_jsonl(&path).expect("file scans");
        assert_eq!(scan.session_id.as_deref(), Some("sid"));
        assert_eq!(scan.cwd.as_deref(), Some("/tmp"));
        assert!(
            scan.first_user_text.is_none(),
            "no user turn → skip candidate"
        );
    }

    #[test]
    fn dir_fallback_discovers_map_unknown_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Map: one session whose file lives elsewhere.
        let known_file = dir.path().join("known.jsonl");
        std::fs::write(
            &known_file,
            concat!(
                r#"{"type":"session","id":"map-sid","cwd":"/tmp/known","timestamp":"2026-08-16T10:00:00.000Z"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"map session"}]}}"#,
                "\n",
            ),
        )
        .expect("write known");
        let map = dir.path().join("session-map.json");
        std::fs::write(
            &map,
            format!(
                r#"{{"version":1,"sessions":{{"map-sid":{{"sessionId":"map-sid","cwd":"/tmp/known","sessionFile":{},"updatedAt":"2026-08-16T10:00:01.000Z"}}}}}}"#,
                serde_json::to_string(&known_file).expect("quote path")
            ),
        )
        .expect("write map");
        // Dir: one session that is ONLY here (the PW1 case) + the same map id
        // under a different filename (dedup probe).
        let sub = dir.path().join("sessions").join("--tmp--");
        std::fs::create_dir_all(&sub).expect("mkdir");
        std::fs::write(
            sub.join("2026-08-16T22-20-38-442Z_dir-sid.jsonl"),
            concat!(
                r#"{"type":"session","id":"dir-sid","cwd":"/tmp/factory","timestamp":"2026-08-16T22:20:38.442Z"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"dir session"}]}}"#,
                "\n",
            ),
        )
        .expect("write dir session");
        std::fs::write(
            sub.join("2026-08-16T11-00-00-000Z_map-sid.jsonl"),
            r#"{"type":"session","id":"map-sid","cwd":"/tmp/known","timestamp":"2026-08-16T11:00:00.000Z"}"#,
        )
        .expect("write dup");

        let found = discover_sessions(&map, &dir.path().join("sessions"));
        let ids: Vec<&str> = found.iter().map(|s| s.session_id.as_str()).collect();
        assert!(ids.contains(&"map-sid"), "map entry discovered: {ids:?}");
        assert!(
            ids.contains(&"dir-sid"),
            "dir-only entry discovered: {ids:?}"
        );
        assert_eq!(
            ids.iter().filter(|id| **id == "map-sid").count(),
            1,
            "dir entry deduped against map: {ids:?}"
        );
        let dir_entry = found
            .iter()
            .find(|s| s.session_id == "dir-sid")
            .expect("dir entry");
        assert_eq!(dir_entry.cwd, "/tmp/factory");
        assert!(dir_entry.updated_at.is_some());

        // Corrupt map → warn + the dir fallback still works.
        std::fs::write(&map, "{not json").expect("corrupt map");
        let found = discover_sessions(&map, &dir.path().join("sessions"));
        assert!(
            found.iter().any(|s| s.session_id == "dir-sid"),
            "dir fallback survives a corrupt map"
        );
        // Absent map → same.
        let found = discover_sessions(&dir.path().join("nope.json"), &dir.path().join("sessions"));
        assert!(found.iter().any(|s| s.session_id == "dir-sid"));
    }

    #[test]
    fn filename_fallback_yields_session_id() {
        let path = Path::new("/x/2026-08-16T22-20-38-442Z_01a00ca9-dead.jsonl");
        assert_eq!(
            session_id_from_filename(path).as_deref(),
            Some("01a00ca9-dead")
        );
        assert_eq!(
            session_id_from_filename(Path::new("/x/nounderscore.jsonl")),
            None
        );
    }

    #[test]
    fn path_prefix_respects_boundaries() {
        assert!(is_path_prefix("/a", "/a"));
        assert!(is_path_prefix("/a", "/a/b"));
        assert!(!is_path_prefix("/a", "/ab"));
        assert!(is_path_prefix("/", "/anything"));
    }
}
