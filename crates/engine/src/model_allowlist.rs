//! Per-harness model allowlist (fork feature).
//!
//! `ListModels` normally echoes the harness's full catalog (pi alone
//! advertises ~15 models). The owner wants the picker to show only a curated
//! subset, declared in `~/.zeron/model-allowlist.json` — a map from harness
//! wire key (`"pi"`, `"claude-code"`, …) to glob patterns matched against
//! each model's id (`provider/modelId`, with the bare `modelId` also
//! accepted):
//!
//! ```json
//! {
//!   "pi": ["xai/grok-4.6", "zai/glm-5.3", "deepseek-payg/*"]
//! }
//! ```
//!
//! Rules (the engine NEVER fails or filters the catalog away because of this
//! file — a picker with no models would brick the app):
//! * no file / unreadable / corrupt / empty file ⇒ pass-through + warning;
//! * harness key absent from the file ⇒ pass-through, silently;
//! * patterns that match nothing in the catalog ⇒ pass-through + warning;
//! * otherwise the catalog is trimmed to the matching entries.
//!
//! The file is re-read on every `ListModels` (rare). No mtime cache: a
//! same-length edit in the same tick cannot go stale, and tests do not share
//! process-global state. Filtering happens at the RPC seam only
//! (`ListModels` in `rpc.rs`), after the harness's own discovery — the ACP
//! layer is untouched, so adapter reinstalls can't regress this.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use zeron_proto::{HarnessId, Model};

/// Overrides the config path (tests / dev); defaults to
/// `~/.zeron/model-allowlist.json`.
const PATH_ENV: &str = "ZERON_MODEL_ALLOWLIST";

/// Parsed config file: harness wire key → glob patterns.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
struct AllowlistFile(HashMap<String, Vec<String>>);

fn config_path() -> PathBuf {
    match std::env::var_os(PATH_ENV) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => crate::repos::home_dir().join(".zeron/model-allowlist.json"),
    }
}

/// Read + parse the file at `path`. Absent/corrupt/empty ⇒ the default
/// (filter-nothing) config plus a warning, never an error.
fn load(path: &Path) -> AllowlistFile {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!(path = %path.display(), "model allowlist file not found; catalogs pass through unfiltered");
            AllowlistFile::default()
        }
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "model allowlist file is unreadable; catalogs pass through unfiltered");
            AllowlistFile::default()
        }
        Ok(text) if text.trim().is_empty() => {
            tracing::warn!(path = %path.display(), "model allowlist file is empty; catalogs pass through unfiltered");
            AllowlistFile::default()
        }
        Ok(text) => match serde_json::from_str::<AllowlistFile>(&text) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "model allowlist file is corrupt; catalogs pass through unfiltered");
                AllowlistFile::default()
            }
        },
    }
}

fn entry_for(file: &AllowlistFile, harness_key: &str) -> Option<Vec<String>> {
    // An explicitly empty list is treated as "no entry": filtering to zero
    // models is never the intent (and would brick the picker).
    file.0.get(harness_key).cloned().filter(|v| !v.is_empty())
}

/// Classic wildcard match: `?` = any single char, `*` = any run of chars
/// INCLUDING `/` (so `deepseek-payg/*` still matches the three-segment id
/// `deepseek-payg/deepseek/deepseek-v4-pro`).
fn glob_match(pattern: &[char], text: &[char]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut star_t) = (usize::MAX, 0usize);
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == '?' || pattern[pi] == text[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == '*' {
            star = pi;
            star_t = ti;
            pi += 1;
        } else if star != usize::MAX {
            star_t += 1;
            ti = star_t;
            pi = star + 1;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == '*' {
        pi += 1;
    }
    pi == pattern.len()
}

/// Does any pattern match `id`? A pattern is tried against the full id
/// (`provider/modelId`), the modelId after the first `/`, and the final
/// segment — covering bare-modelId patterns for both plain ids
/// (`xai/grok-4.6` ← `grok-4.6`) and nested ones
/// (`deepseek-payg/deepseek/deepseek-v4-pro` ← `deepseek-v4-pro`).
fn id_matches(patterns: &[String], id: &str) -> bool {
    let chars: Vec<char> = id.chars().collect();
    let after_first = id.split_once('/').map(|(_, t)| t);
    let last = id.rsplit_once('/').map(|(_, t)| t);
    patterns.iter().any(|p| {
        let p: Vec<char> = p.chars().collect();
        glob_match(&p, &chars)
            || after_first.is_some_and(|t| glob_match(&p, &t.chars().collect::<Vec<char>>()))
            || last.is_some_and(|t| glob_match(&p, &t.chars().collect::<Vec<char>>()))
    })
}

/// Core filter (pure, one pass): keep matching models; if none match,
/// return the catalog untouched (never an empty picker).
fn filter(patterns: &[String], models: Vec<Model>) -> (Vec<Model>, usize) {
    if models.is_empty() {
        return (models, 0);
    }
    let kept: Vec<Model> = models
        .iter()
        .filter(|m| id_matches(patterns, &m.id))
        .cloned()
        .collect();
    let n = kept.len();
    if n == 0 {
        (models, 0)
    } else {
        (kept, n)
    }
}

/// Wire key for a harness (`HarnessId::Pi` → `"pi"`), matching the JSON
/// config keys. Serialization of this enum is infallible in practice; the
/// empty fallback simply means "no entry ⇒ unfiltered".
fn harness_key(id: HarnessId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn apply_from(file: &AllowlistFile, harness: HarnessId, models: Vec<Model>) -> Vec<Model> {
    let key = harness_key(harness);
    match entry_for(file, &key) {
        None => models,
        Some(patterns) => {
            let before = models.len();
            let (out, matched) = filter(&patterns, models);
            if matched == 0 {
                tracing::warn!(harness = %key, patterns = ?patterns, "model allowlist matched no catalog entry; catalogs pass through unfiltered");
            } else {
                tracing::info!(harness = %key, before, after = out.len(), "model allowlist applied");
            }
            out
        }
    }
}

/// RPC-seam entry point (`ListModels`): trim `models` to the harness's
/// allowlist entry. Never fails; see module docs for the pass-through rules.
pub fn apply_for(harness: HarnessId, models: Vec<Model>) -> Vec<Model> {
    apply_from(&load(&config_path()), harness, models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> Model {
        Model {
            id: id.to_string(),
            label: id.to_string(),
            description: None,
            reasoning_levels: Vec::new(),
            options: Vec::new(),
        }
    }

    /// The 5-model pi catalog the owner curates out of the full 15.
    const OWNER_PATTERNS: &[&str] = &[
        "xai/grok-4.6",
        "zai/glm-5.3",
        "kimi-coding/k3",
        "alibaba/qwen3.8-max",
        "deepseek-payg/*",
    ];

    fn full_pi_catalog() -> Vec<Model> {
        [
            "xai/grok-4.3",
            "xai/grok-4.5",
            "xai/grok-4.6",
            "xai/grok-build-0.1",
            "zai/glm-4.7",
            "zai/glm-5.2",
            "zai/glm-5.2-highspeed",
            "zai/glm-5-turbo",
            "zai/glm-5.3",
            "kimi-coding/k3",
            "kimi-coding/k3-256k",
            "kimi-coding/kimi-for-coding",
            "kimi-coding/kimi-for-coding-highspeed",
            "alibaba/qwen3.8-max",
            "deepseek-payg/deepseek/deepseek-v4-pro",
        ]
        .into_iter()
        .map(model)
        .collect()
    }

    #[test]
    fn glob_crosses_slashes_and_handles_questions() {
        let g = |p: &str, t: &str| {
            let p: Vec<char> = p.chars().collect();
            let t: Vec<char> = t.chars().collect();
            glob_match(&p, &t)
        };
        // `*` spans `/`: the whole point of the deepseek pattern.
        assert!(g(
            "deepseek-payg/*",
            "deepseek-payg/deepseek/deepseek-v4-pro"
        ));
        assert!(g("*", "anything/at/all"));
        assert!(g("grok-4.?", "grok-4.6"));
        assert!(!g("grok-4.?", "grok-4.11"));
        assert!(g("xai/grok-4.6", "xai/grok-4.6"));
        assert!(!g("xai/grok-4.6", "xai/grok-4.5"));
        assert!(!g("deepseek-payg/*", "zai/glm-5.3"));
        assert!(g("*glm*", "zai/glm-5.3"));
    }

    #[test]
    fn id_matches_accepts_bare_model_id() {
        let pats = ["grok-4.6".to_string()];
        assert!(id_matches(&pats, "xai/grok-4.6"));
        let pats = ["deepseek-v4-pro".to_string()];
        assert!(id_matches(&pats, "deepseek-payg/deepseek/deepseek-v4-pro"));
    }

    #[test]
    fn owners_patterns_keep_exactly_the_curated_five() {
        let patterns: Vec<String> = OWNER_PATTERNS.iter().map(|s| s.to_string()).collect();
        let (out, n) = filter(&patterns, full_pi_catalog());
        assert_eq!(n, 5);
        let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "xai/grok-4.6",
                "zai/glm-5.3",
                "kimi-coding/k3",
                "alibaba/qwen3.8-max",
                "deepseek-payg/deepseek/deepseek-v4-pro",
            ]
        );
    }

    #[test]
    fn non_matching_patterns_pass_through_untouched() {
        let patterns: Vec<String> = vec!["nope/*".to_string()];
        let catalog = full_pi_catalog();
        let (out, n) = filter(&patterns, catalog.clone());
        assert_eq!(n, 0);
        assert_eq!(out, catalog); // never an empty picker
    }

    #[test]
    fn empty_patterns_pass_through() {
        let (out, n) = filter(&[], full_pi_catalog());
        assert_eq!(n, 0);
        assert_eq!(out.len(), 15);
    }

    #[test]
    fn harness_key_matches_wire_names() {
        assert_eq!(harness_key(HarnessId::Pi), "pi");
        assert_eq!(harness_key(HarnessId::ClaudeCode), "claude-code");
    }

    #[test]
    fn parse_rejects_non_object_json() {
        // Valid JSON, wrong shape: treated as corrupt (default) by `load`'s
        // caller; here we verify the raw parse fails so `load`'s arm is hit.
        assert!(serde_json::from_str::<AllowlistFile>("[1,2]").is_err());
        assert!(serde_json::from_str::<AllowlistFile>("{\"pi\": null}").is_err());
        let ok: AllowlistFile = serde_json::from_str("{\"pi\": [\"xai/grok-4.6\"]}").unwrap();
        let got: Vec<&str> =
            ok.0.get("pi")
                .map(|v| v.iter().map(String::as_str).collect())
                .unwrap_or_default();
        assert_eq!(got, vec!["xai/grok-4.6"]);
    }

    #[test]
    fn load_reads_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("allowlist.json");
        std::fs::write(&path, "{\"pi\": [\"xai/grok-4.6\", \"deepseek-payg/*\"]}").unwrap();
        let file = load(&path);
        let got: Vec<&str> = file
            .0
            .get("pi")
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(got, vec!["xai/grok-4.6", "deepseek-payg/*"]);
    }

    #[test]
    fn load_defaults_on_absent_empty_and_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        // Absent.
        let file = load(&dir.path().join("nope.json"));
        assert_eq!(file, AllowlistFile::default());
        // Empty (whitespace only).
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "   \n").unwrap();
        let file = load(&empty);
        assert_eq!(file, AllowlistFile::default());
        // Corrupt.
        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "{\"pi\": [").unwrap();
        let file = load(&corrupt);
        assert_eq!(file, AllowlistFile::default());
    }

    #[test]
    fn entry_for_treats_empty_list_as_absent() {
        let mut map = HashMap::new();
        map.insert("pi".to_string(), Vec::new());
        let file = AllowlistFile(map);
        assert!(entry_for(&file, "pi").is_none());
        assert!(entry_for(&file, "codex").is_none());
    }

    #[test]
    fn apply_without_entry_passes_the_catalog_through() {
        // Composition view of apply_for's no-entry path: an absent/corrupt
        // file loads as the default map, whose (only) entries never match a
        // harness key, so filter is never even consulted.
        let dir = tempfile::tempdir().unwrap();
        let file = load(&dir.path().join("nope.json"));
        assert!(entry_for(&file, "pi").is_none());
        let catalog = full_pi_catalog();
        let (out, n) = filter(&[], catalog.clone());
        assert_eq!(n, 0);
        assert_eq!(out, catalog);
    }

    #[test]
    fn apply_from_filters_pi_and_passes_other_harnesses() {
        let file: AllowlistFile = serde_json::from_str(
            r#"{"pi": ["xai/grok-4.6", "zai/glm-5.3", "kimi-coding/k3", "alibaba/qwen3.8-max", "deepseek-payg/*"]}"#,
        )
        .unwrap();
        let ids: Vec<String> = apply_from(&file, HarnessId::Pi, full_pi_catalog())
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "xai/grok-4.6",
                "zai/glm-5.3",
                "kimi-coding/k3",
                "alibaba/qwen3.8-max",
                "deepseek-payg/deepseek/deepseek-v4-pro",
            ]
        );
        assert_eq!(
            apply_from(&file, HarnessId::ClaudeCode, full_pi_catalog()).len(),
            15
        );
        let miss: AllowlistFile = serde_json::from_str(r#"{"pi": ["nope/*"]}"#).unwrap();
        assert_eq!(
            apply_from(&miss, HarnessId::Pi, full_pi_catalog()).len(),
            15
        );
    }
}
