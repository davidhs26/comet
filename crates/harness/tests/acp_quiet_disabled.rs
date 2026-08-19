//! ID01-475 default-OFF regression: `ZERON_ACP_QUIET_SETTLE_MS` ALONE must
//! not arm the blanket quiet settle — only the `ZERON_ACP_QUIET_SETTLE`
//! boolean does (read once per process). Own test binary for the same
//! reason the ON-path binary exists: the gate is a OnceLock, and a single
//! process cannot test both polarities. Mirrors `acp_quiet.rs` (helpers
//! duplicated on purpose — each binary is its own process).

use std::path::PathBuf;
use std::sync::Once;
use std::time::Duration;

use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};

use zeron_harness::{AcpHarness, CancellationToken, Harness, RunControls, SteerMessage};
use zeron_proto::{AgentEvent, RunRequest, SandboxLevel, UserInputAnswer, UserInputQuestion};

const QUIET_MS: u64 = 1200;

fn init_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: set before any harness runs in this test process. SOLO
        // the MS knob — the boolean gate stays unset (and is scrubbed, so
        // a stray ZERON_ACP_QUIET_SETTLE in the ambient environment cannot
        // arm the watchdog under this test).
        unsafe { std::env::remove_var("ZERON_ACP_QUIET_SETTLE") };
        unsafe { std::env::set_var("ZERON_ACP_QUIET_SETTLE_MS", QUIET_MS.to_string()) };
    });
}

fn fixture_path() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-acp.sh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    path
}

fn request(prompt: &str) -> RunRequest {
    RunRequest {
        prompt: prompt.into(),
        harness: None,
        model: Some("grok-4.5".into()),
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: "/tmp".into(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        attachments: Vec::new(),
        worktree: None,
        resume: None,
    }
}

fn controls() -> (RunControls, mpsc::Sender<SteerMessage>, CancellationToken) {
    let (steer_tx, steer_rx) = mpsc::channel(8);
    let token = CancellationToken::new();
    let controls = RunControls {
        request_input: Box::new(move |questions: Vec<UserInputQuestion>| {
            let (tx, rx) = oneshot::channel();
            let answers: Vec<UserInputAnswer> = questions
                .iter()
                .map(|q| UserInputAnswer {
                    question_id: q.id.clone(),
                    labels: vec!["Yes".into()],
                })
                .collect();
            let _ = tx.send(answers);
            rx
        }),
        steering: steer_rx,
        interrupt: token.clone(),
    };
    (controls, steer_tx, token)
}

async fn run_and_collect(
    harness: AcpHarness,
    prompt: &str,
    timeout: Duration,
) -> Vec<(std::time::Instant, AgentEvent)> {
    let (controls, _steer, _token) = controls();
    let harness = harness.with_executable(fixture_path());
    let stream = harness
        .run(request(prompt), controls)
        .await
        .expect("run starts");
    tokio::time::timeout(timeout, async move {
        let mut stream = stream;
        let mut events = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push((std::time::Instant::now(), ev.expect("stream event")));
        }
        events
    })
    .await
    .expect("run finished in time")
}

/// The regression the incident's mitigation relied on: a stale
/// `ZERON_ACP_QUIET_SETTLE_MS` in the environment (e.g. the 180000 left in
/// `~/.zeron/env`) must NOT re-arm the watchdog once the gate defaults OFF.
/// The fixture streams content, then goes quiet with no open tool call for
/// 8s — ≥3× the 1.2s window — before its stream EOFs. With the gate OFF no
/// Done may arrive inside that quiet stretch; whatever ends the turn can
/// only come after the fixture's own EOF.
#[tokio::test]
async fn ms_alone_does_not_arm_the_quiet_settle() {
    init_env();
    let started = std::time::Instant::now();
    let events = run_and_collect(
        AcpHarness::grok(),
        "scenario:quiet-starve",
        Duration::from_secs(20),
    )
    .await;
    // Content must have been seen (the settle keys on it; without it this
    // test would be vacuous).
    assert!(
        events
            .iter()
            .any(|(_, e)| matches!(e, AgentEvent::TextDelta { text } if text == "working")),
        "fixture must stream content first: {events:?}"
    );
    let early_dones: Vec<std::time::Duration> = events
        .iter()
        .filter(|(t, e)| {
            matches!(e, AgentEvent::Done { .. }) && t.duration_since(started) < Duration::from_secs(5)
        })
        .map(|(t, _)| t.duration_since(started))
        .collect();
    // 5s sits between the 1.2s window (an armed settle would fire just
    // past it) and the fixture's 8s EOF, with margin for suite load.
    assert!(
        early_dones.is_empty(),
        "gate OFF: MS alone must not settle the turn — synthetic Done(s) at \
         {early_dones:?}, inside the 8s quiet stretch (window {QUIET_MS}ms): \
         {events:?}"
    );
    // If a Done ever comes, it must postdate the quiet stretch: it is the
    // fixture's own EOF closing a turn whose prompt reply never arrived
    // (Errored — correct), never a synthetic settle Completed.
    if let Some((done_at, _)) = events
        .iter()
        .find(|(_, e)| matches!(e, AgentEvent::Done { .. }))
    {
        let at = done_at.duration_since(started);
        assert!(
            at >= Duration::from_secs(5),
            "any Done must postdate the quiet stretch: {at:?} — {events:?}"
        );
    }
}
