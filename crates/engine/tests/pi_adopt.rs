//! pi-adopt integration: a pi session that lives ONLY in the agent sessions
//! dir (never went through pi-acp — the PW1 spike case) becomes a workspace
//! chat attached to the right space, and a second pass does not duplicate it.
//! `adopt_once` is driven directly: the loop behind `ZERON_ADOPT_PI_SESSIONS`
//! would race other tests through the process-global env.

use std::sync::Arc;

use zeron_engine::{EngineCore, HarnessRegistry, pi_adopt};
use zeron_proto::HarnessId;

const PW1_SESSION: &str = "01a00ca9-a0aa-7f6e-b3bf-5a5df6059b28";
const PW1_TEXT: &str = "Sos la sesion de prueba PW1 del spike pi-worker";

/// A transcript shaped like pi's: `session` header + user turn.
fn write_transcript(path: &std::path::Path, session_id: &str, cwd: &std::path::Path, text: &str) {
    let header = serde_json::json!({
        "type": "session", "version": 3, "id": session_id,
        "timestamp": "2026-08-16T22:20:38.442Z",
        "cwd": cwd.to_str().expect("utf8 path"),
    });
    let user = serde_json::json!({
        "type": "message",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    });
    std::fs::write(path, format!("{header}\n{user}\n")).expect("write transcript");
}

fn assemble(data_dir: &std::path::Path) -> EngineCore {
    EngineCore::assemble(
        data_dir,
        Arc::new(HarnessRegistry::new()),
        HarnessId::Mock,
        None,
    )
    .expect("engine core assembles")
}

#[tokio::test]
async fn adopts_dir_only_session_attaches_space_and_stays_idempotent() {
    let data = tempfile::tempdir().expect("engine tempdir");
    let core = assemble(data.path());
    let workspace = core.workspace.clone();

    // Target cwd + a pre-existing space for it: adoption must ATTACH, not
    // create a second space.
    let root = tempfile::tempdir().expect("cwd tempdir");
    let cwd = root.path().join("factory-pw1");
    std::fs::create_dir_all(&cwd).expect("mkdir cwd");
    let cwd_str = cwd.to_str().expect("utf8 path").to_owned();
    workspace
        .create_space(
            "space-pw1",
            &core.device_id,
            &cwd_str,
            Some("factory-pw1".into()),
            false,
        )
        .expect("seed space");

    // Session store: PW1 transcript (absent from any map) + an empty session
    // (no user turn) that must NOT be adopted.
    let store = tempfile::tempdir().expect("sessions tempdir");
    let sub = store.path().join("--tmp-factory-pw1--");
    std::fs::create_dir_all(&sub).expect("mkdir subdir");
    write_transcript(
        &sub.join(format!("2026-08-16T22-20-38-442Z_{PW1_SESSION}.jsonl")),
        PW1_SESSION,
        &cwd,
        PW1_TEXT,
    );
    std::fs::write(
        sub.join("2026-08-16T23-00-00-000Z_empty-sid.jsonl"),
        format!(
            "{}\n",
            serde_json::json!({"type": "session", "id": "empty-sid", "cwd": cwd_str,
                               "timestamp": "2026-08-16T23:00:00.000Z"})
        ),
    )
    .expect("write empty transcript");
    let absent_map = store.path().join("session-map.json"); // never written

    // Pass 1: map absent → warn path, dir fallback still adopts.
    pi_adopt::adopt_once(&workspace, &absent_map, store.path());
    let chats = workspace.read_chats().expect("read chats");
    assert_eq!(chats.len(), 1, "only the user-bearing session: {chats:?}");
    let chat = &chats[0];
    assert_eq!(chat.harness_session_id.as_deref(), Some(PW1_SESSION));
    assert_eq!(chat.harness_session_cwd.as_deref(), Some(cwd_str.as_str()));
    assert_eq!(chat.cwd.as_deref(), Some(cwd_str.as_str()));
    assert_eq!(
        chat.title.as_deref(),
        Some("Sos la sesion de prueba PW1 del spike pi-worker")
    );
    assert_eq!(chat.space_id.as_deref(), Some("space-pw1"));
    assert_eq!(chat.config.as_ref().expect("config").harness, HarnessId::Pi);
    assert_eq!(chat.room_gen, Some(2));
    assert!(!chat.archived);
    let first_id = chat.id.clone();

    // Pass 2: same scan → no duplicates.
    pi_adopt::adopt_once(&workspace, &absent_map, store.path());
    assert_eq!(workspace.read_chats().expect("read chats").len(), 1);

    // Pass 3: now the map ALSO lists the session (dedup by pi session id).
    std::fs::write(
        &absent_map,
        serde_json::json!({
            "version": 1,
            "sessions": {PW1_SESSION: {
                "sessionId": PW1_SESSION, "cwd": cwd_str,
                "sessionFile": sub.join(format!("2026-08-16T22-20-38-442Z_{PW1_SESSION}.jsonl")),
                "updatedAt": "2026-08-16T22:21:00.000Z",
            }}
        })
        .to_string(),
    )
    .expect("write map");
    pi_adopt::adopt_once(&workspace, &absent_map, store.path());
    let chats = workspace.read_chats().expect("read chats");
    assert_eq!(chats.len(), 1, "map + dir dedup to one chat");
    assert_eq!(chats[0].id, first_id, "deterministic id across passes");

    // No extra spaces were created for the adopted chat.
    let spaces = workspace.read_spaces().expect("read spaces");
    assert_eq!(spaces.len(), 1, "adoption attached to the seeded space");
    assert_eq!(spaces[0].id, "space-pw1");

    core.shutdown().await;
}

#[tokio::test]
async fn adopts_without_any_space_and_creates_one() {
    let data = tempfile::tempdir().expect("engine tempdir");
    let core = assemble(data.path());
    let workspace = core.workspace.clone();

    let root = tempfile::tempdir().expect("cwd tempdir");
    let cwd = root.path().join("orphan-proj");
    std::fs::create_dir_all(&cwd).expect("mkdir cwd");
    let store = tempfile::tempdir().expect("sessions tempdir");
    let sub = store.path().join("--orphan--");
    std::fs::create_dir_all(&sub).expect("mkdir subdir");
    write_transcript(
        &sub.join("2026-08-17T10-00-00-000Z_orphan-sid.jsonl"),
        "orphan-sid",
        &cwd,
        "chat sin space previo",
    );

    pi_adopt::adopt_once(&workspace, &store.path().join("no-map.json"), store.path());
    let chats = workspace.read_chats().expect("read chats");
    assert_eq!(chats.len(), 1);
    let space_id = chats[0].space_id.as_deref().expect("space resolved");
    let spaces = workspace.read_spaces().expect("read spaces");
    let space = spaces
        .iter()
        .find(|s| s.id == space_id)
        .expect("space row exists");
    assert_eq!(space.path, cwd.to_str().expect("utf8 path"));
    assert_eq!(space.name.as_deref(), Some("orphan-proj"));
    assert!(!space.git_detected);

    core.shutdown().await;
}
