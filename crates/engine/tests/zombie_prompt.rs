//! The zombie-prompt abort (SPEC-ID01-519 bug 2, 2026-08-18 incident).
//!
//! A WORKING run whose stream has been silent for a while with NOTHING in
//! flight is a turn whose harness Done went missing. Its ACP mailbox would
//! queue any newly dispatched prompt as a steer until the turn boundary
//! that never comes — the incident's nudge sat 435s until the quiesce
//! watchdog parked the zombie. dispatch now interrupts such a run and
//! starts a fresh turn instead; `ZERON_ZOMBIE_PROMPT_MS` sets the silence
//! window (0 disables — always-steer, the pre-fix behavior).
//!
//! The in-flight gate is the watchdog's own (`fold_inflight`): an open
//! tool call legitimately silent for minutes still STEERS, never aborts —
//! and a PARKED (Done-parked, child warm) run steers as before; only the
//! Working-but-mute shape trips the abort.
//!
//! Separate binary (see `turn_quiesce.rs`): the env knobs are
//! process-global — here the zombie window is 1.2s and the quiesce
//! watchdog is pushed far past the test horizon so any prompt effect can
//! only have come through the zombie gate, well inside the window the
//! quiesce park would have needed.

use std::sync::{Arc, Once};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use tokio::sync::{Mutex, mpsc};

use zeron_doc::{MessagePart, MessageRole, MessageStatus, SessionMessageEntry};
use zeron_engine::{EngineCore, HarnessRegistry};
use zeron_harness::{Harness, HarnessError, RunControls};
use zeron_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SandboxLevel,
    SessionStatus, SteeringMode, ToolCall,
};

const CHAT: &str = "chat-zombie-prompt";
/// Zombie silence window under test.
const ZOMBIE_MS: u64 = 1_200;
/// Quiesce watchdog: far beyond the test horizon — a park can only be
/// ruled out, never blamed, for anything observed here.
const QUIESCE_MS: u64 = 600_000;

fn init_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: called before any engine (and thus any reader of the vars)
        // exists in this test process.
        unsafe {
            std::env::set_var("ZERON_ZOMBIE_PROMPT_MS", ZOMBIE_MS.to_string());
            std::env::set_var("ZERON_TURN_QUIESCE_MS", QUIESCE_MS.to_string());
        }
    });
}

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

fn done(status: DoneStatus) -> AgentEvent {
    AgentEvent::Done {
        status,
        result: None,
        error: None,
        session_id: Some("hs-zp".into()),
    }
}

fn session_started() -> AgentEvent {
    AgentEvent::SessionStarted {
        harness: HarnessId::Mock,
        model: "mock-1".into(),
        tools: vec![],
        cwd: "/tmp".into(),
        session_id: "hs-zp".into(),
        assistant_message_id: "a-zp".into(),
    }
}

fn text(t: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: t.into() }
}

/// Feed-by-hand harness (see `turn_quiesce.rs`), plus an OBEDIENT
/// interrupt: the engine's interrupt token surfaces as the child's own
/// `Done{Interrupted}` — the ACP teardown shape — so the zombie abort is
/// observable as an aborted entry, not only as a run id swap.
struct FeedHarness {
    main_prompt: String,
    feed: Mutex<Option<mpsc::UnboundedReceiver<AgentEvent>>>,
}

#[async_trait]
impl Harness for FeedHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Mock
    }
    fn display_name(&self) -> &str {
        "Feed"
    }
    fn supports_steering(&self) -> bool {
        true
    }
    fn steering_mode(&self) -> SteeringMode {
        SteeringMode::StepBoundary
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
        mut controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        if request.prompt != self.main_prompt {
            // Non-main dispatches (the fresh turn after an abort): a short,
            // clean turn — Done immediately.
            let events = vec![Ok(done(DoneStatus::Completed))];
            return Ok(futures::stream::iter(events).boxed());
        }
        let mut feed = self
            .feed
            .lock()
            .await
            .take()
            .expect("FeedHarness serves the main dispatch once per test");
        let (tx, rx) = mpsc::channel::<Result<AgentEvent, HarnessError>>(64);
        tokio::spawn(async move {
            let mut steering_open = true;
            loop {
                tokio::select! {
                    biased;
                    _ = controls.interrupt.cancelled() => {
                        // Obedient teardown: the interrupt is the child's
                        // own turn end, aborted.
                        let _ = tx.send(Ok(done(DoneStatus::Interrupted))).await;
                        return;
                    }
                    steer = controls.steering.recv(), if steering_open => match steer {
                        Some(_) => {
                            let boundary = AgentEvent::Steered {
                                assistant_message_id: None,
                                next_assistant_message_id: None,
                            };
                            if tx.send(Ok(boundary)).await.is_err() {
                                return;
                            }
                        }
                        None => steering_open = false,
                    },
                    event = feed.recv() => match event {
                        Some(event) => {
                            if tx.send(Ok(event)).await.is_err() {
                                return;
                            }
                        }
                        None => return,
                    },
                }
            }
        });
        Ok(futures::stream::unfold(rx, |mut rx| async {
            rx.recv().await.map(|event| (event, rx))
        })
        .boxed())
    }
}

struct Rig {
    core: EngineCore,
    feed: mpsc::UnboundedSender<AgentEvent>,
    _dir: tempfile::TempDir,
}

fn assemble(main_prompt: &str) -> Rig {
    init_env();
    let (feed, rx) = mpsc::unbounded_channel();
    let registry = HarnessRegistry::new();
    registry.register(Arc::new(FeedHarness {
        main_prompt: main_prompt.into(),
        feed: Mutex::new(Some(rx)),
    }));
    let dir = tempfile::tempdir().unwrap();
    let core = EngineCore::assemble(dir.path(), Arc::new(registry), HarnessId::Mock, None)
        .expect("engine core assembles");
    Rig {
        core,
        feed,
        _dir: dir,
    }
}

fn status(core: &EngineCore) -> Option<SessionStatus> {
    core.sessions.session_status(CHAT).map(|s| s.status)
}

/// Tolerant read (see `e2e.rs`): a snapshot mid-segment-write deserializes with
/// fields missing — treat that instant as "not yet".
fn entries(core: &EngineCore) -> Vec<SessionMessageEntry> {
    core.doc_host
        .open(CHAT)
        .ok()
        .and_then(|h| h.doc().read_entries().ok())
        .unwrap_or_default()
}

fn assistant_texts(core: &EngineCore) -> Vec<(String, Option<MessageStatus>)> {
    entries(core)
        .into_iter()
        .filter(|e| e.role == MessageRole::Assistant)
        .map(|e| {
            let text = e
                .parts
                .iter()
                .filter_map(|p| match p {
                    MessagePart::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            (text, e.status)
        })
        .collect()
}

fn user_texts(core: &EngineCore) -> Vec<String> {
    entries(core)
        .into_iter()
        .filter(|e| e.role == MessageRole::User)
        .map(|e| {
            e.parts
                .iter()
                .filter_map(|p| match p {
                    MessagePart::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .collect()
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
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The incident's shape: a Working turn with output behind it goes silent
/// with nothing in flight (harness Done missing). A new prompt must NOT be
/// routed as a steer into that zombie's mailbox — the run is interrupted
/// (its streaming entry settles `aborted`) and the prompt starts a fresh
/// turn, all in a fraction of the quiesce window.
#[tokio::test]
async fn zombie_silent_run_is_aborted_and_replaced() {
    let rig = assemble("run the long migration");
    let run1 = rig
        .core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("run the long migration"),
            None,
        )
        .await
        .expect("dispatch");

    rig.feed.send(session_started()).unwrap();
    rig.feed.send(text("Migration 40% done.")).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "zombie turn is Working",
    )
    .await;

    // Stream silent well past the zombie window, nothing in flight.
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    // The user nudges the zombie. Pre-fix this routed as a steer into the
    // mailbox and sat there until the 600s quiesce park; post-fix it
    // interrupts the zombie and returns a FRESH run id.
    let started = std::time::Instant::now();
    let run2 = rig
        .core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("stop — summarize what migrated so far"),
            None,
        )
        .await
        .expect("dispatch");
    assert_ne!(run1, run2, "a prompt on a zombie must start a fresh run");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the zombie swap must complete in a fraction of the quiesce window, \
         took {:?}",
        started.elapsed()
    );

    // The zombie's streaming entry settles aborted, and both the old text
    // and the new prompt are in the transcript.
    wait_for(
        || {
            assistant_texts(&rig.core).iter().any(|(t, s)| {
                t.contains("Migration 40% done") && *s == Some(MessageStatus::Aborted)
            })
        },
        "zombie entry settles aborted",
    )
    .await;
    assert!(
        user_texts(&rig.core)
            .iter()
            .any(|t| t.contains("summarize what migrated")),
        "the nudging prompt must be in the transcript, got {:?}",
        user_texts(&rig.core)
    );

    // The fresh turn runs and parks (the harness serves it a quick Done).
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "fresh turn completes and parks",
    )
    .await;

    rig.core.sessions.shutdown().await;
}

/// The guard the spec insists on: an open tool call is legitimately silent
/// for minutes — with work in flight the run is NOT a zombie, and the
/// prompt routes as a steer to the SAME run.
#[tokio::test]
async fn open_tool_blocks_the_zombie_abort_and_steers_instead() {
    let rig = assemble("run the slow build");
    let run1 = rig
        .core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("run the slow build"),
            None,
        )
        .await
        .expect("dispatch");

    rig.feed.send(session_started()).unwrap();
    rig.feed.send(text("Kicking off the build.")).unwrap();
    rig.feed
        .send(AgentEvent::ToolCall {
            id: "tool-slow".into(),
            call: ToolCall::Exec {
                command: "cargo build --release".into(),
            },
        })
        .unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "run starts Working",
    )
    .await;

    // Silence well past the zombie window — but the tool is unresolved:
    // in flight, so never a zombie.
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    let run2 = rig
        .core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("status update?"), None)
        .await
        .expect("dispatch");
    assert_eq!(
        run1, run2,
        "a run with an open tool must take the prompt as a steer, not an abort"
    );

    // The steer's boundary re-arms Working and nothing settles aborted.
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "steered run is Working",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !assistant_texts(&rig.core)
            .iter()
            .any(|(_, s)| *s == Some(MessageStatus::Aborted)),
        "no entry may settle aborted while the tool is legitimately running"
    );

    rig.core.sessions.shutdown().await;
}

/// A PARKED run (Done-parked, child warm, status Idle) is not a zombie
/// however silent: a dispatch steers it as before.
#[tokio::test]
async fn parked_session_still_takes_the_steer() {
    let rig = assemble("watch the build");
    let run1 = rig
        .core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("watch the build"), None)
        .await
        .expect("dispatch");

    rig.feed.send(session_started()).unwrap();
    rig.feed.send(text("Watching.")).unwrap();
    rig.feed.send(done(DoneStatus::Completed)).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "park after Done",
    )
    .await;

    // Silent far past the zombie window — but PARKED, so the dispatch
    // routes as a steer into the warm child, run id unchanged.
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    let run2 = rig
        .core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("what changed?"), None)
        .await
        .expect("dispatch");
    assert_eq!(run1, run2, "a parked run must take the prompt as a steer");

    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "steer re-arms Working",
    )
    .await;
    rig.feed.send(text("Nothing yet.")).unwrap();
    rig.feed.send(done(DoneStatus::Completed)).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "clean turn end",
    )
    .await;

    rig.core.sessions.shutdown().await;
}
