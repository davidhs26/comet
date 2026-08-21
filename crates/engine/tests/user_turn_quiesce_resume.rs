//! The LONG quiesce window survives a quiesce-parked USER turn's resume
//! (SPEC-ID01-519 bug 3, 2026-08-18 incident).
//!
//! A user-prompted turn streams output and its harness Done goes missing
//! (bug 1 — out of scope here; only its consequences). The quiesce
//! watchdog parks the turn on the LONG window: correct. But when the turn
//! later resumes with more output, the resume path blanket-armed the
//! SELF-CONTINUED short window: the incident's 300s window shrank to 20s
//! and the turn re-parked ~24s after resuming, flapping Working/Idle until
//! the next output arrived. A quiesce park of a USER turn is that same
//! turn PAUSING — its resume must keep the long window. Only a Done-park
//! (or the quiesce of a turn that was already self-continued) arms the
//! short window on resume; the sibling test here pins that half too.
//!
//! Separate binary (see `self_continued_quiesce.rs`): the env knobs are
//! process-global, and this one needs a LONG window small enough to
//! observe a park within the test horizon yet clearly above the short one.

use std::sync::{Arc, Once};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use tokio::sync::{Mutex, mpsc};

use zeron_engine::{EngineCore, HarnessRegistry};
use zeron_harness::{Harness, HarnessError, RunControls};
use zeron_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SandboxLevel,
    SessionStatus, SteeringMode,
};

const CHAT: &str = "chat-user-quiesce";
/// LONG window: long enough that a resumed USER turn must NOT re-park
/// inside the assertion horizon, short enough to observe the park itself.
const QUIESCE_MS: u64 = 3_000;
/// SHORT window: what a resumed USER turn must NOT be parked on (the bug).
const SELF_QUIESCE_MS: u64 = 400;

fn init_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: called before any engine (and thus any reader of the vars)
        // exists in this test process.
        unsafe {
            std::env::set_var("ZERON_TURN_QUIESCE_MS", QUIESCE_MS.to_string());
            std::env::set_var("ZERON_SELF_TURN_QUIESCE_MS", SELF_QUIESCE_MS.to_string());
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
        session_id: Some("hs-uq".into()),
    }
}

fn session_started() -> AgentEvent {
    AgentEvent::SessionStarted {
        harness: HarnessId::Mock,
        model: "mock-1".into(),
        tools: vec![],
        cwd: "/tmp".into(),
        session_id: "hs-uq".into(),
        assistant_message_id: "a-uq".into(),
    }
}

fn text(t: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: t.into() }
}

/// Feed-by-hand harness (see `turn_quiesce.rs`): the test pushes events
/// through a channel; accepted steers confirm with a `Steered` boundary.
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

/// The incident's shape: a USER turn whose harness Done went missing gets
/// quiesce-parked on the LONG window; the turn later resumes with more
/// output. The resume must NOT arm the short self-continued window — the
/// turn is the SAME user turn continuing, so the next silence re-parks on
/// the long window only.
#[tokio::test]
async fn user_turn_resume_keeps_the_long_window() {
    let rig = assemble("run the migration");
    rig.core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("run the migration"),
            None,
        )
        .await
        .expect("dispatch");

    // The user turn streams output… and its Done never comes.
    rig.feed.send(session_started()).unwrap();
    rig.feed.send(text("Migration 40% done.")).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "user turn is Working",
    )
    .await;

    // The watchdog parks it on the LONG window (3s here; 300s in prod).
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "quiesce parks the user turn on the long window",
    )
    .await;

    // The turn resumes with more output, past the resume gate.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    rig.feed.send(text("Still going — tests running.")).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "user turn resumes Working",
    )
    .await;

    // THE BUG: the resume armed the short window, so the turn re-parked
    // ~400ms after resuming. With the fix it must still be Working well
    // past the short window — the next park belongs to the LONG one.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        status(&rig.core),
        Some(SessionStatus::Working),
        "a resumed quiesce-parked USER turn must not re-park on the short window"
    );

    // The watchdog itself stays armed: the resumed turn re-parks on the
    // long window (~3s after its last output).
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "long window re-parks the resumed user turn",
    )
    .await;

    rig.core.sessions.shutdown().await;
}

/// Control: the fix must not widen the post-DONE path. A Done-parked
/// session resumed by self-continued output still arms the SHORT window —
/// that is what keeps background wakes from reading as 2min of phantom
/// Working (2026-08-13), and this pins it under this binary's knobs.
#[tokio::test]
async fn done_park_resume_still_arms_the_short_window() {
    let rig = assemble("watch the build");
    rig.core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("watch the build"), None)
        .await
        .expect("dispatch");

    rig.feed.send(session_started()).unwrap();
    rig.feed.send(text("I will watch the build.")).unwrap();
    rig.feed.send(done(DoneStatus::Completed)).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "park after Done",
    )
    .await;

    // Self-continued output past the resume gate re-arms Working…
    tokio::time::sleep(Duration::from_millis(1200)).await;
    rig.feed.send(text("The build is green.")).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "self-continued output resumes Working",
    )
    .await;

    // …and parks again on the SHORT window: 400ms, well inside this 1.5s
    // check (the long window here would only park at 3s).
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        status(&rig.core),
        Some(SessionStatus::Idle),
        "a Done-parked session's self-continued resume must still park on the short window"
    );

    rig.core.sessions.shutdown().await;
}
