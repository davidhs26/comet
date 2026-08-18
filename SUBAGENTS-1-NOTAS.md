# Notas — Subagentes foreground (ID01-432)

Branch: `feat/subagents-foreground`. Extensión runtime: `~/.pi/agent/extensions/subagents.ts` (mismos bytes que `tooling/pi-extensions/subagents.ts`).

## Qué hay
Tool `subagents` foreground: spawn argv + stdin ignore, cap 4, timeout TERM→KILL, depth cap, revisor≠implementador, output 8KB tail, cleanup en `session_shutdown`.

## Tests
`node tooling/pi-extensions/subagents.test.mjs` — unit. E2E skip (`SUBAGENTS_E2E=1`).

## No verificado
- Chat Zeron nuevo viendo la tool (hace falta sesión nueva post-swap; las extensiones cargan al start).
- E2E real contra qwen (quota).
