//! A FINISHED subagent must not pin the in-flight gate (2026-08-20 incident,
//! chat 9d321b30 — Pi via pi-acp, but the shape is harness-agnostic).
//!
//! The parent feed spawns a subagent as TWO tool ids: the spawn call itself
//! (`call-parent`, settled eagerly by its own `ToolResult`) and the chip that
//! indexes the nested transcript (`call-parent:agent-1`), which never gets a
//! `ToolResult` at all — it closes through `Subagent { Done }`, i.e. through
//! `subagent_status`, not through `resolved`.
//!
//! `fold_inflight` read `resolved` alone, so every finished subagent left one
//! phantom in-flight part behind. That gate guards BOTH silence paths — the
//! quiesce watchdog's park and dispatch's zombie abort — so a single spawn
//! disarmed both for the rest of the chat. In the incident a turn whose
//! provider stream died sat Working for 35 minutes: no park, and no way for a
//! prompt to abort it.
//!
//! Separate binary: the quiesce knob is process-global.

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
    SessionStatus, SteeringMode, ToolCall,
};

const CHAT: &str = "chat-subagent-chip";
/// Watchdog window for every test in this file.
const QUIESCE_MS: u64 = 300;
/// The spawn call the parent agent makes (settles eagerly).
const SPAWN: &str = "call-parent";
/// The chip that indexes the subagent transcript — `parent:agentId`, the
/// composite id the adapter mints. No `ToolResult` ever carries it.
const CHIP: &str = "call-parent:agent-1";

fn init_quiesce_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: called before any engine (and thus any reader of the var)
        // exists in this test process; all tests share the one value.
        unsafe { std::env::set_var("ZERON_TURN_QUIESCE_MS", QUIESCE_MS.to_string()) };
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
        session_id: Some("hs-sc".into()),
    }
}

fn session_started() -> AgentEvent {
    AgentEvent::SessionStarted {
        harness: HarnessId::Mock,
        model: "mock-1".into(),
        tools: vec![],
        cwd: "/tmp".into(),
        session_id: "hs-sc".into(),
        assistant_message_id: "a-sc".into(),
    }
}

fn text(t: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: t.into() }
}

fn tool_call(id: &str, name: &str) -> AgentEvent {
    AgentEvent::ToolCall {
        id: id.into(),
        call: ToolCall::Unknown {
            name: name.into(),
            input: None,
        },
    }
}

fn tool_result(id: &str) -> AgentEvent {
    AgentEvent::ToolResult {
        id: id.into(),
        is_error: false,
        output: None,
        diff: None,
    }
}

fn tagged(event: AgentEvent) -> AgentEvent {
    AgentEvent::Subagent {
        parent_tool_use_id: CHIP.into(),
        event: Box::new(event),
    }
}

/// Feed-by-hand harness (see `turn_quiesce.rs`). The feed is served only to
/// the test's own dispatch (matched by prompt) — the auto-titler runs this
/// harness too, and gets an immediately-completed empty stream instead.
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
        Ok(futures::stream::unfold(rx, |mut rx| async move {
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
    init_quiesce_env();
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

/// Drive the incident's opening: spawn a subagent, settle the spawn call
/// eagerly, and stream one tagged delta so the chip reads `running`.
async fn spawn_subagent(rig: &Rig) {
    rig.feed.send(session_started()).unwrap();
    rig.feed
        .send(text("Handing the review to an agent."))
        .unwrap();
    rig.feed.send(tool_call(SPAWN, "subagents")).unwrap();
    rig.feed
        .send(tool_call(CHIP, "Agent: agent-1 (review)"))
        .unwrap();
    rig.feed
        .send(tagged(text("Reading the diff against the spec.")))
        .unwrap();
    // Eager-done: the spawn call settles under the PARENT id while the
    // subagent is still running. The chip keeps `resolved: false` for good.
    rig.feed.send(tool_result(SPAWN)).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Working),
        "run reads Working while the subagent streams",
    )
    .await;
}

/// The regression: once the subagent reports Done, the turn holds NOTHING in
/// flight, so a stream that then goes silent past the window must park. Before
/// the fix the chip pinned the gate and this waited forever — the shape that
/// stranded the incident's chat Working for 35 minutes.
#[tokio::test]
async fn finished_subagent_chip_releases_the_quiesce_watchdog() {
    let rig = assemble("review the diff");
    rig.core
        .sessions
        .dispatch(CHAT, HarnessId::Mock, run_request("review the diff"), None)
        .await
        .expect("dispatch");

    spawn_subagent(&rig).await;

    rig.feed.send(tagged(done(DoneStatus::Completed))).unwrap();
    // The parent stream dies here: no text, no Done, nothing — exactly what a
    // provider stream that hangs mid-turn looks like from the engine.
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "watchdog parks the turn once the subagent has settled",
    )
    .await;
}

/// The other half of the gate, and the reason this is not simply an exemption:
/// a LIVE subagent is real work in flight (the incident's chat ran an
/// 18.5-minute implement agent), so the watchdog must keep refusing to park
/// until its Done lands.
#[tokio::test]
async fn running_subagent_still_pins_the_quiesce_watchdog() {
    let rig = assemble("implement the spec");
    rig.core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("implement the spec"),
            None,
        )
        .await
        .expect("dispatch");

    spawn_subagent(&rig).await;

    // Silence far past the window: the subagent is working, nothing parks.
    tokio::time::sleep(Duration::from_millis(QUIESCE_MS * 4)).await;
    assert_eq!(
        status(&rig.core),
        Some(SessionStatus::Working),
        "a running subagent must hold the turn Working"
    );

    // Its Done releases the gate — same wait as the test above, proving the
    // pin was the subagent's liveness and not the chip's `resolved` flag.
    rig.feed.send(tagged(done(DoneStatus::Completed))).unwrap();
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "watchdog parks once the subagent finishes",
    )
    .await;
}

/// The claude foreground shape (review ID01-529): there the chip IS the
/// tool-use id, so when the Task completes its own `ToolResult` settles the
/// chip (`resolved: true`) while `subagent_status` never leaves `Running`.
/// Before the review fix the Running arm read `true` unconditionally, so
/// that ToolResult pinned the in-flight gate for the rest of the turn —
/// WORSE than pre-PR behavior for claude, where `resolved: true` used to
/// release. Here the resolved chip must release the gate even without a
/// tagged Done: the stream then goes silent and the watchdog must park.
#[tokio::test]
async fn resolved_running_chip_releases_the_quiesce_watchdog() {
    let rig = assemble("review with claude task");
    rig.core
        .sessions
        .dispatch(
            CHAT,
            HarnessId::Mock,
            run_request("review with claude task"),
            None,
        )
        .await
        .expect("dispatch");

    // Same opening: chip Running and unresolved. The claude difference is
    // what comes next — the chip's own ToolResult, no tagged Done at all.
    spawn_subagent(&rig).await;
    rig.feed.send(tool_result(CHIP)).unwrap();

    // Stream dies silent with the chip `resolved: true` but still tagged
    // Running: the gate must read nothing in flight, so the window parks.
    // With the pre-fix Running arm this never parks — the capture of the
    // review's blocking finding (the wait times out).
    wait_for(
        || status(&rig.core) == Some(SessionStatus::Idle),
        "watchdog parks once the Running chip is resolved",
    )
    .await;
}
