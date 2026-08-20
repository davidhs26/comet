//! SPEC-ID01-459 — session-safe deploys: the drain-wait contract.
//!
//! The shutdown path every deploy rides (`systemctl restart` → SIGTERM, or the
//! `StopEngine` RPC) converges in `Engine::run`'s post-`select!` code:
//! [`EngineCore::drain_for_restart`] (flag `draining` + bounded aggregate wait
//! for natural completion) followed by the interrupting teardown. These tests
//! exercise that contract:
//!
//! - natural completion: the in-flight turn finishes on its own during the
//!   drain window — journal closes with `Done{Completed}`, no `aborted` stamp;
//! - new-run rejection: `QueueCommand` fails fast with the exact drain error
//!   (RPC frame and dispatch seam) while `WatchSessions` keeps streaming;
//! - deadline fallback: a hung turn cannot wedge the shutdown — after the
//!   (explicitly shortened) deadline the regular interrupt path stamps `aborted`
//!   and the teardown completes;
//! - `StopEngine` exits 0 through the same drain (no-regression: with zero
//!   live runs the daemon still stops within the 5s bound).
//!
//! A note on coverage: a live run inside the REAL headless daemon is not
//! injectable from this suite (`Engine::run` assembles the default registry,
//! whose mock completes instantly), so the wait-with-live-run observables are
//! proven against the same `drain_for_restart` the daemon calls, and the
//! daemon-level test proves the StopEngine → drain → exit-0 wiring end to end.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;

use zeron_doc::{MessageRole, MessageStatus, SessionCommandPayload, SessionMessageEntry};
use zeron_engine::{
    DRAINING_ERROR, Engine, EngineConfig, EngineCore, HarnessId, HarnessRegistry, RunJournal,
};
use zeron_harness::{Harness, HarnessError, RunControls};
use zeron_proto::{
    AgentEvent, DoneStatus, Model, ReasoningLevel, RunRequest, SandboxLevel, SteeringMode,
};

const CHAT: &str = "chat-drain";

fn run_request(prompt: &str) -> RunRequest {
    RunRequest {
        prompt: prompt.into(),
        harness: None,
        model: None,
        reasoning: None,
        model_options: Default::default(),
        cwd: "/tmp".into(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        attachments: Vec::new(),
        worktree: None,
        resume: None,

        utility: false,
    }
}

/// A run whose completion the test holds in its hands: `run()` emits
/// `SessionStarted` and then parks. `hang = false` → parks until the test
/// releases the latch (natural completion). `hang = true` → never completes
/// (the hung turn the deadline fallback must survive).
struct LatchHarness {
    release: Arc<tokio::sync::Notify>,
    hang: bool,
}

#[async_trait]
impl Harness for LatchHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Mock
    }
    fn display_name(&self) -> &str {
        "Latch"
    }
    fn supports_steering(&self) -> bool {
        false
    }
    fn steering_mode(&self) -> SteeringMode {
        SteeringMode::TurnBoundary
    }
    fn reasoning_levels(&self) -> &[ReasoningLevel] {
        &[ReasoningLevel::Medium]
    }
    async fn models(&self) -> Result<Vec<Model>, HarnessError> {
        Ok(vec![])
    }
    async fn run(
        &self,
        request: RunRequest,
        _controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<AgentEvent, HarnessError>>(32);
        let release = self.release.clone();
        let hang = self.hang;
        let cwd = request.cwd.clone();
        tokio::spawn(async move {
            let started = AgentEvent::SessionStarted {
                harness: HarnessId::Mock,
                model: "mock-1".into(),
                tools: vec![],
                cwd,
                session_id: "hs-latch".into(),
                assistant_message_id: "a-latch".into(),
            };
            if tx.send(Ok(started)).await.is_err() {
                return;
            }
            let delta = AgentEvent::TextDelta {
                text: "working…".into(),
            };
            if tx.send(Ok(delta)).await.is_err() {
                return;
            }
            if hang {
                // Hung: never emits Done — only the engine's interrupt path
                // (grace deadline) can settle this run.
                std::future::pending::<()>().await;
            } else {
                release.notified().await;
                let done = AgentEvent::Done {
                    status: DoneStatus::Completed,
                    result: None,
                    error: None,
                    session_id: Some("hs-latch".into()),
                };
                let _ = tx.send(Ok(done)).await;
            }
        });
        Ok(futures::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|ev| (ev, rx))
        })
        .boxed())
    }
}

fn assemble(dir: &std::path::Path, harness: LatchHarness) -> EngineCore {
    let registry = HarnessRegistry::new();
    registry.register(Arc::new(harness));
    EngineCore::assemble(dir, Arc::new(registry), HarnessId::Mock, None)
        .expect("engine core assembles")
}

fn queue_run(core: &EngineCore, prompt: &str, message_id: &str) {
    core.doc_host
        .queue_command(
            CHAT,
            SessionCommandPayload::Run {
                request: run_request(prompt),
                message_id: message_id.into(),
            },
        )
        .expect("queue run command");
}

async fn wait_for<F>(mut predicate: F, what: &str)
where
    F: FnMut() -> bool,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

/// Tolerant read for hot-polling predicates (mirrors restart_resume.rs).
fn entries_now(core: &EngineCore) -> Vec<SessionMessageEntry> {
    core.doc_host
        .open(CHAT)
        .ok()
        .and_then(|h| h.doc().read_entries().ok())
        .unwrap_or_default()
}

/// Create + name the chat row up front so the auto-titler stays out of the
/// run's way (same trick as restart_resume.rs `pre_title`).
fn pre_title(core: &EngineCore) {
    core.workspace
        .create_space("space-drain", &core.device_id, "/tmp", None, false)
        .expect("create space row");
    core.workspace
        .create_chat(CHAT, Some("space-drain"), None, None, None)
        .expect("create chat row");
    core.workspace
        .rename_chat(CHAT, "Pre-titled")
        .expect("rename chat");
}

/// The drain `Engine::run` enters after SIGTERM must wait for the in-flight
/// turn's NATURAL completion — journal closes `Done{Completed}`, the
/// assistant entry settles `Complete`, nothing is stamped `aborted`.
/// Known gap (accepted): this drives `drain_for_restart` directly — there is
/// no subprocess-level SIGTERM test with a live run in this suite, so the
/// signal wiring itself rides on the StopEngine daemon test below.
#[tokio::test]
async fn drain_waits_for_natural_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let release = Arc::new(tokio::sync::Notify::new());
    let core = assemble(
        &dir,
        LatchHarness {
            release: release.clone(),
            hang: false,
        },
    );
    pre_title(&core);
    queue_run(&core, "in-flight turn", "msg-user-1");
    wait_for(|| core.sessions.any_active(), "turn to go live").await;

    // The turn finishes on its own ~500ms into the drain window.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        release.notify_one();
    });
    // Exactly what `Engine::run` runs between the shutdown signal and
    // `server.abort()` (drain deadline shortened for the test).
    core.drain_for_restart(8).await;

    // Natural completion observables: Done{Completed}, entry Complete.
    // (Tolerant poll: the doc commit is coalesced — the journal closes before
    // the folded entry lands in the doc.)
    let journal = RunJournal::open(dir.join("orgs/dev-org/dev-user/journals")).unwrap();
    let (_, last) = journal.last_event(CHAT).unwrap().expect("journal closed");
    assert!(
        matches!(
            &last,
            AgentEvent::Done {
                status: DoneStatus::Completed,
                ..
            }
        ),
        "run must complete naturally during the drain, got {last:?}"
    );
    wait_for(
        || {
            let entries = entries_now(&core);
            entries.len() == 2
                && entries[1].role == MessageRole::Assistant
                && entries[1].status == Some(MessageStatus::Complete)
        },
        "drained transcript to settle complete (no aborted stamp)",
    )
    .await;
    core.shutdown().await;
}

/// C1.2: while draining, `QueueCommand` that would dispatch a NEW run fails
/// with the exact drain error (RPC frame + dispatch seam), while
/// `WatchSessions` keeps streaming and the live run still completes.
#[tokio::test]
async fn queue_rejected_while_draining() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let release = Arc::new(tokio::sync::Notify::new());
    let core = assemble(
        &dir,
        LatchHarness {
            release: release.clone(),
            hang: false,
        },
    );
    pre_title(&core);
    let client = zeron_rpc::memory_client(core.rpc_service());
    let mut sessions_stream = client
        .subscribe(zeron_rpc::methods::WATCH_SESSIONS, serde_json::Value::Null)
        .await
        .expect("subscribe sessions");
    // Drain the initial snapshot frame.
    tokio::time::timeout(Duration::from_secs(5), sessions_stream.recv())
        .await
        .expect("initial sessions frame")
        .expect("sessions stream alive");

    queue_run(&core, "in-flight turn", "msg-user-1");
    wait_for(|| core.sessions.any_active(), "turn to go live").await;

    // Enter the drain state (the window is explicit — this suite never
    // touches ZERON_DRAIN_TIMEOUT_SECS: tests share one process, and a
    // global env var would leak into the other tests' daemon).
    core.sessions.begin_drain(30);

    // RPC seam: the standard method-error frame carries the exact text.
    let command = serde_json::to_value(SessionCommandPayload::Run {
        request: run_request("new turn during drain"),
        message_id: "msg-rejected".into(),
    })
    .unwrap();
    let err = client
        .call(
            zeron_rpc::methods::QUEUE_COMMAND,
            serde_json::json!({ "chatId": CHAT, "command": command }),
        )
        .await
        .expect_err("QueueCommand must be rejected while draining");
    assert_eq!(err.to_string(), DRAINING_ERROR);

    // Dispatch seam (in-flight frames cannot start a run post-flag either —
    // the non-steerable live run means this dispatch WOULD start a new one).
    let err = core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("direct dispatch"), None)
        .await
        .expect_err("dispatch must be rejected while draining");
    assert_eq!(err.to_string(), DRAINING_ERROR);

    // Observation RPCs stay alive: the stream delivers the Idle transition
    // as the drained run completes.
    release.notify_one();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let item = tokio::time::timeout_at(deadline, sessions_stream.recv())
            .await
            .expect("sessions stream must keep streaming during the drain")
            .expect("sessions stream alive");
        let list: Vec<serde_json::Value> = serde_json::from_value(item).unwrap();
        if list.first().and_then(|s| s["status"].as_str()) == Some("idle") {
            break;
        }
    }
    core.drain_for_restart(30).await;
    core.shutdown().await;
}

/// C1.2 (review fix): the drain gate is exactly as wide as the contract —
/// only commands that would dispatch a NEW run are rejected. Against a live
/// NON-steerable run (the Latch harness), `Interrupt` and `RespondInput`
/// pass the RPC seam during the drain (they accelerate or destraban the
/// in-flight turn), while `Run` is rejected outright and a `Steer` is
/// rejected because with no steerable run its fallback would dispatch.
#[tokio::test]
async fn interrupt_and_respond_input_pass_while_draining() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let core = assemble(
        &dir,
        LatchHarness {
            release: Arc::new(tokio::sync::Notify::new()),
            hang: true,
        },
    );
    pre_title(&core);
    let client = zeron_rpc::memory_client(core.rpc_service());

    queue_run(&core, "hung non-steerable turn", "msg-user-1");
    wait_for(|| core.sessions.any_active(), "turn to go live").await;

    core.sessions.begin_drain(30);

    // Interrupt passes — and its downstream application settles the hung
    // turn, which is the point: it accelerates the drain, never starts work.
    let interrupt = serde_json::to_value(SessionCommandPayload::Interrupt {}).unwrap();
    let reply = client
        .call(
            zeron_rpc::methods::QUEUE_COMMAND,
            serde_json::json!({ "chatId": CHAT, "command": interrupt }),
        )
        .await
        .expect("Interrupt must pass the drain gate");
    assert!(reply.get("commandId").is_some(), "got {reply:?}");

    // RespondInput passes the gate even with no matching pending question
    // (an orphan answer rejects downstream — never with the drain error).
    let respond = serde_json::to_value(SessionCommandPayload::RespondInput {
        request_id: "req-none".into(),
        answers: vec![],
    })
    .unwrap();
    let reply = client
        .call(
            zeron_rpc::methods::QUEUE_COMMAND,
            serde_json::json!({ "chatId": CHAT, "command": respond }),
        )
        .await
        .expect("RespondInput must pass the drain gate");
    assert!(reply.get("commandId").is_some(), "got {reply:?}");

    // The same gate still rejects the two shapes that would dispatch a new
    // run against this non-steerable chat.
    let run = serde_json::to_value(SessionCommandPayload::Run {
        request: run_request("new turn during drain"),
        message_id: "msg-rejected".into(),
    })
    .unwrap();
    let err = client
        .call(
            zeron_rpc::methods::QUEUE_COMMAND,
            serde_json::json!({ "chatId": CHAT, "command": run }),
        )
        .await
        .expect_err("Run must be rejected while draining");
    assert_eq!(err.to_string(), DRAINING_ERROR);

    let steer = serde_json::to_value(SessionCommandPayload::Steer {
        prompt: "steer during drain".into(),
        message_id: None,
    })
    .unwrap();
    let err = client
        .call(
            zeron_rpc::methods::QUEUE_COMMAND,
            serde_json::json!({ "chatId": CHAT, "command": steer }),
        )
        .await
        .expect_err("Steer without a steerable run must be rejected while draining");
    assert_eq!(err.to_string(), DRAINING_ERROR);

    // The queued Interrupt does its job: the hung run settles without any
    // drain deadline having to expire.
    wait_for(
        || !core.sessions.any_active(),
        "queued interrupt to settle the hung run",
    )
    .await;
    core.shutdown().await;
}

/// C2: a hung turn cannot wedge the shutdown. After the (shortened)
/// deadline the drain falls back to the regular interrupt path — `aborted`
/// stamp, synthetic `Done{Interrupted}` — and the teardown completes.
#[tokio::test]
async fn drain_timeout_falls_back_to_interrupt() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let core = assemble(
        &dir,
        LatchHarness {
            release: Arc::new(tokio::sync::Notify::new()),
            hang: true,
        },
    );
    pre_title(&core);
    queue_run(&core, "hung turn", "msg-user-1");
    wait_for(|| core.sessions.any_active(), "hung turn to go live").await;

    // Deadline expires (1s) → the drain reports nothing; the regular
    // teardown below is the interrupt fallback. The deadline rides
    // `drain_for_restart`'s explicit parameter — no env mutation (see the
    // note on `begin_drain` above).
    core.drain_for_restart(1).await;
    // In-process equivalent of "the engine process exits": shutdown returns
    // (bounded by the interrupt's settle wait + the 3s run-task grace).
    tokio::time::timeout(Duration::from_secs(20), core.shutdown())
        .await
        .expect("interrupt fallback must settle the shutdown");

    let journal = RunJournal::open(dir.join("orgs/dev-org/dev-user/journals")).unwrap();
    let (_, last) = journal.last_event(CHAT).unwrap().expect("journal closed");
    assert!(
        matches!(
            &last,
            AgentEvent::Done {
                status: DoneStatus::Interrupted,
                ..
            }
        ),
        "fallback must take the interrupt path, got {last:?}"
    );
    wait_for(
        || {
            let entries = entries_now(&core);
            entries.len() == 2
                && entries[1].role == MessageRole::Assistant
                && entries[1].status == Some(MessageStatus::Aborted)
        },
        "hung run must be stamped aborted by the interrupt fallback",
    )
    .await;
}

/// C1.1: StopEngine shares the SIGTERM drain path. The REAL headless daemon
/// (same `Engine::run` the SIGTERM signal handler arms) answers `{ok:true}`,
/// drains (zero live runs → immediate), and exits 0 within the 5s bound —
/// the wait-with-live-run observables are covered by the drain test above
/// against the same `drain_for_restart`.
#[tokio::test]
async fn stopengine_shares_drain_path() {
    let dir = tempfile::tempdir().unwrap();
    let port = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let config = EngineConfig {
        data_dir: dir.path().to_path_buf(),
        edge_url: "http://127.0.0.1:1".into(),
        edge_token: None,
        ipc_port: port,
        default_harness: HarnessId::Mock,
        org_id: None,
        workos_client_id: None,
    };
    let daemon = tokio::spawn(Engine::new(config).run());

    let client = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(client) = zeron_rpc::connect_ws(&format!("ws://127.0.0.1:{port}")).await {
                break client;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("headless IPC did not start");

    assert_eq!(
        client
            .call(zeron_rpc::methods::STOP_ENGINE, serde_json::json!({}))
            .await
            .unwrap(),
        serde_json::json!({ "ok": true })
    );
    // Exit 0 through the shared drain path, still inside the 5s bound.
    tokio::time::timeout(Duration::from_secs(5), daemon)
        .await
        .expect("headless engine did not stop")
        .expect("headless task panicked")
        .expect("headless shutdown failed");

    tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("headless IPC port remained occupied after shutdown");
}
