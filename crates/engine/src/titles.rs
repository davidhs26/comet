//! Chat auto-titling — after the first user+assistant exchange completes on an
//! untitled chat, name it with the harness's cheapest model (port of zeron's
//! `generateTitle` in `sessions.ts`).
//!
//! Flow (fire-and-forget from the run task; every failure is a silent skip with
//! tracing — a title must never fail or delay a run):
//! 1. skip when the chat already has a title (or has no workspace row);
//! 2. pick the run harness's cheapest model (small-tier name heuristic, else the
//!    last listed model — zeron's `cheapestModel`);
//! 3. run a one-shot, non-streaming-collected titling prompt through the
//!    [`Harness`] trait (read-only sandbox, minimal reasoning, auto-approve),
//!    retrying on zeron's short backoff ladder; fall back to the prompt's first
//!    words when every attempt produces nothing;
//! 4. re-check the title (a user rename during generation wins);
//! 5. when the chat sits in a zeron worktree (`zeron/<name>` branch), rename the
//!    branch from the title and update the chat's branch row;
//! 6. `rename_chat` in the workspace doc.

use std::sync::Arc;

use futures::StreamExt;

use zeron_harness::{CancellationToken, RunControls, SteerMessage};
use zeron_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SandboxLevel,
    UserInputAnswer, UserInputQuestion,
};

use crate::EngineError;
use crate::registry::HarnessRegistry;
use crate::repos::Repos;
use crate::workspace_host::WorkspaceHost;

/// Throwaway title runs are cheap but still cross a process boundary — retry a
/// couple of times with a short backoff before falling back (zeron's ladder).
const RETRY_DELAYS_MS: &[u64] = &[250, 1_000];

/// Prefix of the machine-to-machine titling prompt. `pi_adopt` matches on this
/// prefix to skip titling sessions as noise — keep both sides in sync by
/// construction (this constant is the single source of truth).
pub(crate) const TITLE_PROMPT_PREFIX: &str = "Reply with ONLY a concise";

struct Inner {
    workspace: WorkspaceHost,
    registry: Arc<HarnessRegistry>,
    repos: Repos,
}

#[derive(Clone)]
pub struct TitleGenerator {
    inner: Arc<Inner>,
}

impl TitleGenerator {
    pub fn new(workspace: WorkspaceHost, registry: Arc<HarnessRegistry>, repos: Repos) -> Self {
        Self {
            inner: Arc::new(Inner {
                workspace,
                registry,
                repos,
            }),
        }
    }

    /// Fire-and-forget: title `chat_id` if it's still untitled. Called by the run
    /// task after a completed exchange; runs detached so it never delays anything.
    pub fn maybe_generate(&self, chat_id: &str, harness: HarnessId, prompt: &str, cwd: &str) {
        let this = self.clone();
        let chat_id = chat_id.to_string();
        let prompt = prompt.to_string();
        let cwd = cwd.to_string();
        tokio::spawn(async move {
            if let Err(err) = this.generate(&chat_id, harness, &prompt, &cwd).await {
                tracing::debug!(chat = %chat_id, error = %err, "chat auto-titling skipped");
            }
        });
    }

    async fn generate(
        &self,
        chat_id: &str,
        harness_id: HarnessId,
        prompt: &str,
        cwd: &str,
    ) -> Result<(), EngineError> {
        let chat = self
            .inner
            .workspace
            .chat(chat_id)?
            .ok_or_else(|| EngineError::Other("chat has no workspace row".into()))?;
        if chat.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            return Ok(()); // already named
        }

        let generated = self.run_title_model(harness_id, prompt, cwd).await;
        // Fallback so a chat is always named even if the model run produced nothing.
        let fallback: String = prompt
            .split_whitespace()
            .take(7)
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(48)
            .collect();
        let title = generated.unwrap_or(fallback);
        if title.is_empty() {
            return Ok(());
        }

        // Re-read after the model call: a user may have named the chat or checked
        // out another branch while the throwaway generation was live.
        let latest = self.inner.workspace.chat(chat_id)?.unwrap_or(chat);
        if latest
            .title
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty())
        {
            return Ok(());
        }

        // Rename the worktree branch when the chat still sits on its original
        // zeron/<name> branch (guards live inside rename_worktree_branch).
        if let (Some(chat_cwd), Some(branch)) = (&latest.cwd, &latest.branch)
            && branch.starts_with("zeron/")
        {
            match self
                .inner
                .repos
                .rename_worktree_branch(std::path::Path::new(chat_cwd), branch, &title)
                .await
            {
                Ok(renamed) if &renamed != branch => {
                    if let Err(err) = self.inner.workspace.set_chat_branch(chat_id, &renamed) {
                        tracing::warn!(chat = %chat_id, error = %err, "chat branch update failed");
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    tracing::warn!(chat = %chat_id, error = %err, "automatic worktree branch rename failed");
                }
            }
        }

        self.inner.workspace.rename_chat(chat_id, &title)?;
        tracing::info!(chat = %chat_id, title = %title, "chat auto-titled");
        Ok(())
    }

    /// One-shot titling run: collect TextDeltas until Done; retries on failure.
    async fn run_title_model(
        &self,
        harness_id: HarnessId,
        prompt: &str,
        cwd: &str,
    ) -> Option<String> {
        let harness = match self.inner.registry.resolve(harness_id) {
            Ok(harness) => harness,
            Err(err) => {
                tracing::debug!(error = %err, "titling harness unavailable");
                return None;
            }
        };
        let cheap = cheapest_model(&harness.models().await.unwrap_or_default());
        let title_prompt = format!(
            "{TITLE_PROMPT_PREFIX} 3-5 word title in Title Case (no quotes, no punctuation) \
             for a coding session that begins with this request:\n\n{prompt}"
        );
        for attempt in 0..=RETRY_DELAYS_MS.len() {
            let request = title_run_request(
                title_prompt.clone(),
                harness_id,
                cheap.clone(),
                cwd,
            );
            match collect_text(harness.as_ref(), request).await {
                Ok(raw) => {
                    let candidate = clean_title(&raw);
                    if !candidate.is_empty() {
                        return Some(candidate);
                    }
                }
                Err(err) => {
                    tracing::warn!(attempt = attempt + 1, error = %err,
                        "automatic chat title generation attempt failed");
                }
            }
            if let Some(delay) = RETRY_DELAYS_MS.get(attempt) {
                tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
            }
        }
        None
    }
}

/// The cheapest model a harness offers (zeron's `cheapestModel` heuristic):
/// prefer a small-tier name (haiku/mini/nano/flash/small/lite), else the last
/// listed model; `None` when the catalog is empty (harness picks its default).
fn cheapest_model(models: &[Model]) -> Option<String> {
    if models.is_empty() {
        return None;
    }
    let small = models.iter().find(|m| {
        let haystack = format!("{} {}", m.id, m.label).to_lowercase();
        ["haiku", "mini", "nano", "flash", "small", "lite"]
            .iter()
            .any(|tier| haystack.contains(tier))
    });
    small.or(models.last()).map(|m| m.id.clone())
}

/// Best title-looking line, stripped of dressing, capped at 60 chars.
///
/// La primera línea gana si ya parece un título (modelo bien portado). Si es
/// una oración — un modelo que narra su plan antes de responder (con
/// utility-guard bloqueándole las tools, ID01-491) deja el título al FINAL
/// del texto — se toma la ÚLTIMA línea con pinta de título. Fallback: la
/// primera línea truncada (comportamiento previo).
fn clean_title(raw: &str) -> String {
    // Pela comillas, headings y dressing de markdown (bullets, quotes, code):
    // con el escaneo multi-línea CUALQUIER línea es candidata, no solo la 1ª.
    fn strip(line: &str) -> &str {
        line.trim()
            .trim_start_matches(['"', '\'', '#', '-', '*', '>', '`', ' ', '\t'])
            .trim_end_matches(['"', '\'', '`', '*', ' ', '\t'])
    }
    // Puntuación terminal/inicial de oración — un título legítimo con punto
    // final ("Fix login roto.") se acepta PELADO, no se descarta (review k3).
    fn strip_punct(l: &str) -> &str {
        l.trim_start_matches(['\u{00bf}', '\u{00a1}'])
            .trim_end_matches(['.', '!', '?', ':', ',', '\u{2026}'])
            .trim()
    }
    fn looks_like_title(l: &str) -> bool {
        let words = l.split_whitespace().count();
        (1..=8).contains(&words) && l.chars().count() <= 60
    }
    fn ends_with_punct(l: &str) -> bool {
        l.ends_with(['.', '!', '?', ':', ',', '\u{2026}'])
    }
    let lines: Vec<&str> = raw.lines().map(strip).filter(|l| !l.is_empty()).collect();
    let pick = match lines.first() {
        None => "",
        // 1ª línea gana si parece título una vez pelada la puntuación — el
        // preámbulo del incidente (13 palabras) sigue cayendo al escaneo.
        Some(first) if looks_like_title(strip_punct(first)) => strip_punct(first),
        Some(first) => {
            // Escaneo en DOS pasadas (review k3): la puntuación terminal es
            // LA señal que separa título de narración — una despedida corta
            // ("¡Espero que sirva!") no debe ganarle al título real. La
            // pasada laxa (pelada) solo rescata un título con signos
            // ("¿Arreglar login roto?") cuando ninguna línea calificó.
            let strict = lines
                .iter()
                .rev()
                .find(|l| !ends_with_punct(l) && looks_like_title(strip_punct(l)));
            match strict {
                Some(l) => strip_punct(l),
                None => lines
                    .iter()
                    .rev()
                    .map(|l| strip_punct(l))
                    .find(|l| looks_like_title(l))
                    .unwrap_or(first),
            }
        }
    };
    pick.chars().take(60).collect()
}

/// Drive one titling run through the harness: no steering, questions resolved
/// empty immediately (a titling prompt must never block on input).
/// The titling run's [`RunRequest`] — extracted so a unit test can pin its
/// invariants (ID01-491): structurally marked `utility: true` (the ACP driver
/// turns it into the child env `ZERON_UTILITY=1` that pi extensions gate on)
/// and sandboxed read-only with minimal reasoning, fresh session.
fn title_run_request(
    title_prompt: String,
    harness_id: HarnessId,
    model: Option<String>,
    cwd: &str,
) -> RunRequest {
    RunRequest {
        prompt: title_prompt,
        harness: Some(harness_id),
        model,
        reasoning: Some(ReasoningLevel::Minimal),
        model_options: serde_json::Map::new(),
        cwd: cwd.to_string(),
        sandbox: SandboxLevel::ReadOnly,
        auto_approve: true,
        attachments: Vec::new(),
        resume: None,
        worktree: None,
        utility: true,
    }
}

async fn collect_text(
    harness: &dyn zeron_harness::Harness,
    request: RunRequest,
) -> Result<String, EngineError> {
    let (steer_tx, steer_rx) = tokio::sync::mpsc::channel::<SteerMessage>(1);
    let controls = RunControls {
        request_input: Box::new(|_questions: Vec<UserInputQuestion>| {
            let (tx, rx) = tokio::sync::oneshot::channel::<Vec<UserInputAnswer>>();
            let _ = tx.send(Vec::new());
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
    };
    let mut stream = harness.run(request, controls).await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => {
                return Err(EngineError::Other(format!("titling run error: {message}")));
            }
            AgentEvent::Done { status, error, .. } => {
                if status == DoneStatus::Completed {
                    break;
                }
                return Err(EngineError::Other(format!(
                    "titling run ended {status:?}: {}",
                    error.unwrap_or_default()
                )));
            }
            _ => {}
        }
    }
    drop(steer_tx); // keep the mailbox open for the run's whole lifetime
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeron_proto::Model;

    fn model(id: &str, label: &str) -> Model {
        Model {
            id: id.into(),
            label: label.into(),
            description: None,
            reasoning_levels: vec![],
            options: vec![],
        }
    }

    #[test]
    fn cheapest_prefers_small_tier_then_last() {
        let models = vec![
            model("opus-4", "Opus"),
            model("haiku-3", "Haiku"),
            model("sonnet-4", "Sonnet"),
        ];
        assert_eq!(cheapest_model(&models).as_deref(), Some("haiku-3"));
        let no_small = vec![model("opus-4", "Opus"), model("sonnet-4", "Sonnet")];
        assert_eq!(cheapest_model(&no_small).as_deref(), Some("sonnet-4"));
        assert_eq!(cheapest_model(&[]), None);
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("\"Fix Login Flow\"\nextra"), "Fix Login Flow");
        assert_eq!(clean_title("# Add Dark Mode  "), "Add Dark Mode");
        assert_eq!(clean_title("   "), "");
    }

    #[test]
    fn first_line_title_with_terminal_punctuation_wins_stripped() {
        // Review k3: el código viejo usaba "Fix login roto." tal cual; el
        // escaneo NO debe saltearla y elegir un bullet posterior.
        let raw = "Fix login roto.\n\n- Actualicé el utility-guard\n- Tests en verde";
        assert_eq!(clean_title(raw), "Fix login roto");
        // Español con signos: pelados, no descartados.
        assert_eq!(clean_title("\u{00bf}Arreglar login roto?"), "Arreglar login roto");
    }

    #[test]
    fn preamble_before_blocked_tools_yields_the_trailing_title() {
        // Incidente 2026-08-19: el modelo narró su plan, utility-guard le
        // bloqueó las tools, y recién al final respondió el título.
        let raw = "Vamos por partes. Primero leo los dos archivos a editar y la golden suite.\n\nRol Specify Para Flota";
        assert_eq!(clean_title(raw), "Rol Specify Para Flota");
    }

    #[test]
    fn farewell_after_the_title_does_not_win() {
        // Review k3 round 3: la despedida cortés califica pelada — la pasada
        // estricta (sin puntuación) debe preferir el título real.
        let raw = "Vamos por partes. Primero leo los archivos que me pediste revisar hoy.\n\nRol Specify Para Flota\n\n\u{00a1}Espero que sirva!";
        assert_eq!(clean_title(raw), "Rol Specify Para Flota");
        // Negrita: el cierre ** no queda colgando.
        assert_eq!(clean_title("**Rol Specify Para Flota**"), "Rol Specify Para Flota");
    }

    #[test]
    fn title_run_is_structurally_marked_utility_and_read_only() {
        // ID01-491: el run de titulado lleva el marcador estructural (el driver
        // ACP lo traduce en ZERON_UTILITY=1 para las extensiones de pi) y queda
        // sandboxeado read-only, reasoning mínimo, sesión fresca.
        let req = title_run_request(
            format!("{TITLE_PROMPT_PREFIX} 3-5 word title …"),
            HarnessId::Pi,
            Some("cheap-model".into()),
            "/w",
        );
        assert!(req.utility);
        assert_eq!(req.sandbox, SandboxLevel::ReadOnly);
        assert_eq!(req.reasoning, Some(ReasoningLevel::Minimal));
        assert_eq!(req.resume, None);
        assert!(req.auto_approve);
        assert!(req.prompt.starts_with(TITLE_PROMPT_PREFIX));
    }

    #[test]
    fn sentence_only_text_falls_back_to_first_line_capped() {
        let raw = "Esta es una oración larga que no parece un título porque termina con punto y tiene demasiadas palabras para serlo.";
        let t = clean_title(raw);
        assert!(t.starts_with("Esta es una oración larga"));
        assert!(t.chars().count() <= 60);
    }
}
