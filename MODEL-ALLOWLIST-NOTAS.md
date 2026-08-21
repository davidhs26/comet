# MODEL-ALLOWLIST-NOTAS (ID01-422)

## Qué
Filtro declarativo del catálogo de modelos en el engine. El picker de Zeron (iOS/desktop) solo ve los ids que el owner listó en `~/.zeron/model-allowlist.json`.

## Dónde
- `crates/engine/src/model_allowlist.rs` — load + glob. Se relee el archivo en cada `ListModels` (sin cache de mtime).
- `crates/engine/src/rpc.rs` handler `LIST_MODELS` — `apply_for` después de `harness.models()`.
- Override de path: env `ZERON_MODEL_ALLOWLIST`.

## Glob
`*` cruza `/`. `deepseek-payg/*` matchea `deepseek-payg/deepseek/deepseek-v4-pro`. También se prueba el `modelId` pelado y el último segmento.

## Otras superficies
- `harness/acp/models_from_session` corre **adentro** de `harness.models()`; ListModels ya recibe ese catálogo y lo filtra. No hace falta enganchar ACP.
- `ui/normalize_model_rows` solo higieniza lo que ListModels ya devolvió (no reinyecta hermanos).
- `session/new` no es otra fuente del picker. No toqué proto/iOS/edge.

## Fail-open
Archivo ausente / vacío / corrupto / harness sin entrada / 0 matches → catálogo intacto + `tracing::warn`. Nunca lista vacía. Nunca tumba el engine.

## No verificado acá
- Picker real en el iPhone (hace falta swap del binario; eso es humano).
- Recarga en caliente contra un engine en producción.

## Config de esta Beelink
Tras merge/swap, crear `~/.zeron/model-allowlist.json` con:

```json
{
  "pi": [
    "xai/grok-4.6",
    "zai/glm-5.3",
    "kimi-coding/k3",
    "alibaba/qwen3.8-max",
    "deepseek-payg/*"
  ]
}
```
