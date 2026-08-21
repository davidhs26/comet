# INVESTIGACION-EDIT — vía elegida para edit-coach (ID01-453)

Paquete inspeccionado: `@earendil-works/pi-coding-agent@0.84.2` (`node_modules/.../dist/`).

## a) ¿La implementación del tool built-in `edit` es importable? — SÍ

- `dist/core/tools/edit.js:168` → `export function createEditToolDefinition(cwd, options)`;
  `dist/core/tools/edit.js` también exporta `createEditTool(cwd, options)` (firma en
  `dist/core/tools/edit.d.ts:52-53`).
- Re-exportados desde el index público: `dist/core/tools/index.js:2` y
  `dist/index.js:24` (`createEditToolDefinition`, `EditOperations`, `EditToolOptions`, …).
  Verificado en runtime: `import("@earendil-works/pi-coding-agent")` expone
  `createEditToolDefinition` como función.
- Mensaje de error actual en mismatch (lo que ve el modelo hoy), generado en
  `dist/core/tools/edit-diff.js:186-189`:
  - 1 edit:  `Could not find the exact text in <path>. The old text must match exactly including all whitespace and newlines.`
  - N edits: `Could not find edits[<i>] in <path>. The oldText must match exactly including all whitespace and newlines.`
  - (no-mismatch, no se toca: `Found N occurrences of the text in <path>. The text must be unique…`,
    `dist/core/tools/edit-diff.js:191-195`)
- El error viaja como throw desde `execute` (`dist/core/tools/edit.js:211` llama
  `applyEditsToNormalizedContent`) y el agent loop lo convierte en tool result con
  `isError: true` y `content = [{type:"text", text: error.message}]`
  (`pi-agent-core/dist/agent-loop.js:472-479`, `createErrorToolResult(error.message)` en
  `agent-loop.js:448`).

O sea: la implementación built-in es importable y reutilizable. Esto habilita wrappearla.

## b) ¿registerTool con name "edit" REEMPLAZA al built-in o colisiona? — REEMPLAZA

- `pi.registerTool(tool)` (`dist/core/extensions/types.d.ts:902`) guarda en
  `extension.tools.set(tool.name, …)` y dispara `runtime.refreshTools()`
  (`dist/core/extensions/loader.js:215-222`).
- El merge se hace en `AgentSession._refreshToolRegistry`
  (`dist/core/agent-session.js:1945-1994`): primero se cargan los built-ins
  (`_baseToolDefinitions`, líneas 1954-1962 y 1984-1990) y **después** las tools de
  extensiones pisan por nombre en el mismo `Map`:
  - definiciones: `agent-session.js:1963-1968` → `definitionRegistry.set(tool.definition.name, …)`
  - registry ejecutable: `agent-session.js:1990-1993` → `toolRegistry.set(tool.name, tool)`
- No hay validación de colisión por nombre para tools (grep `collision|duplicate|already`
  en `loader.js`/`resource-loader.js`: sin resultados para tools).
- Activación: el nombre "edit" ya está activo como built-in, así que tras el reemplazo
  sigue activo apuntando a la entry nueva (`agent-session.js:1995-2015`).
- La execute de una ToolDefinition registrada recibe el `ExtensionContext` como 5º
  argumento (`types.d.ts:372`), adaptado por `wrapToolDefinition`
  (`dist/core/tools/tool-definition-wrapper.js:2-13`) + `wrapRegisteredTool`
  (`dist/core/extensions/wrapper.js:12-33`). `ExtensionContext.cwd` está en
  `types.d.ts:217`.

## c) ¿Hook/evento para transformar el RESULTADO de un tool call? — SÍ (existe, no elegida)

- `pi.on("tool_result", handler)` (`types.d.ts:898`). Evento `ToolResultEvent`
  (`types.d.ts:692-734`, "Fired after a tool executes. **Can modify result.**",
  línea 733) con `EditToolResultEvent { toolName:"edit", input, content, isError, details }`
  (`types.d.ts:709-712`).
- El handler devuelve `ToolResultEventResult { content?, details?, isError?, usage? }`
  (`types.d.ts:796-801`); el runner mergea campo por campo
  (`dist/core/extensions/runner.js:649-700`) y `AgentSession.afterToolCall` aplica el
  reemplazo (`dist/core/agent-session.js:244-272`).

## Vía elegida: (a)+(b) — override del built-in `edit` via `registerTool`

Corto en la primera vía viable del orden pedido: como (a) es importable y (b) reemplaza
(y no colisiona), la extensión registra una tool llamada `edit` que:

1. Crea perezosamente la definición built-in real con `createEditToolDefinition(ctx.cwd)`
   (una por cwd; `execute` del built-in cierra sobre ese cwd,
   `dist/core/tools/edit.js:168-182`) y le delega TODO: `parameters`, `description`,
   `promptSnippet`, `promptGuidelines`, `constrainedSampling`, `renderShell`,
   `prepareArguments` (puro, cwd-independiente — `edit.js:38-60`), `renderCall`,
   `renderResult` y `execute`.
2. Wrappea SOLO `execute`: si la ejecución tiene éxito, devuelve el resultado intacto.
   Si tira un error cuyo mensaje matchea `Could not find …` (mismatch de `oldText`),
   lee el archivo, corre `edit-core.findClosestMatch` sobre el `oldText` del edit que
   falló (índice parseado del mensaje `edits[<i>]`) y re-lanza un error con el mensaje
   original + bloque coach (excerpt con números de línea, mini-diff, hint). El agent
   loop lo convierte en tool result de error igual que antes
   (`agent-loop.js:472-479`), así que el modelo recibe el texto enriquecido en el
   mismo canal de siempre.
3. NUNCA auto-aplica el match aproximado: solo informa. Si `edit-core` explota o el
   archivo no se puede leer, se re-lanza el error original intacto (nunca empeorar el
   caso base).

Por qué no (c): es igual de viable (firmas verificadas arriba) pero exigiría re-leer y
re-interpretar el error ya serializado desde fuera del tool; (b) intercepta el `Error`
en el origen con el `params` tipado a mano y mantiene un solo punto de verdad para el
schema/rendering del tool. (c) queda documentada como fallback si una versión futura
impidiera el override por nombre.

## Hallazgo adicional (de los tests de integración)

El built-in NO es matching puramente exacto: `fuzzyFindText` (`edit-diff.js:135+`)
prueba match exacto como **substring** y después un fuzzy que normaliza trailing
whitespace, smart quotes, dashes y espacios Unicode (`normalizeForFuzzyMatch`,
`edit-diff.js:30-49`). NO normaliza indentación ni espacios internos, así que los
mismatches que llegan al coach son drift real de contenido o de indentación —
exactamente los casos donde el closest match + diagnóstico le sirven al modelo.

## Firmas exactas usadas

```ts
// dist/core/tools/edit.d.ts:52
export declare function createEditToolDefinition(cwd: string, options?: EditToolOptions):
  ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState>;

// dist/core/extensions/types.d.ts:902
registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>): void;

// dist/core/extensions/types.d.ts:372 (execute de ToolDefinition registrada)
execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext):
  Promise<AgentToolResult<TDetails>>;

// dist/core/extensions/types.d.ts:1107 (factory de la extensión)
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```
