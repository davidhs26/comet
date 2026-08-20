/**
 * todos — to-dos estructurados del agente (ID01-497, SPEC-ID01-497).
 *
 * Tools `set_todos` / `update_todo` con un store in-memory por sesión y un
 * render compacto (§5.3 del spec) que se usa tanto en el tool result como
 * en el texto assistant que emite el orquestador.
 *
 * Decisiones congeladas por el spec:
 * - Canal visible en iOS = TEXTO ASSISTANT compacto (fallback). Esta
 *   extensión NO emite mensajes custom por la API de mensajería de pi en
 *   ningún path: esos mensajes NO atraviesan el adapter ACP hasta iOS
 *   (spec §2.4) y además duplicarían tokens en contexto. El gap ACP queda
 *   como follow-up (spec §11).
 * - Estado in-memory por proceso, UN store por sesión. `session_start`
 *   resetea la lista a vacía y NO se reconstruye desde el historial —
 *   decisión explícita de simplicidad: el agente re-declara sus to-dos con
 *   `set_todos` al arrancar cada tarea.
 * - Transiciones libres entre los 4 estados (sin FSM); múltiples
 *   in_progress permitidos (no hay autoswitch).
 * - note: trim + truncado a 80 chars (se trunca, no se rechaza); visible
 *   SOLO en el render de ítems in_progress.
 * - Throttle: status presente → siempre emite y resetea el timer de note de
 *   ese id; note-only emite solo si pasaron ≥ NOTE_THROTTLE_MS desde el
 *   último emit de ESE id (el estado interno se aplica igual). `set_todos`
 *   siempre emite y resetea el timer de todos los ids.
 * - Reloj inyectable (`now`) para testear el throttle sin sleeps reales.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const NOTE_THROTTLE_MS = 60000;
export const MAX_ITEMS = 15;
export const MAX_NOTE_LEN = 80;

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
	id: string;
	text: string;
	status: TodoStatus;
	note?: string;
}

export interface TodoUpdateResult {
	rendered: string;
	emitted: boolean;
	/** true cuando la note se aplicó internamente pero el render no se emitió (throttle). */
	throttled?: boolean;
}

// Orden de RENDER (spec §5.3): in_progress primero para visibilidad inmediata.
const STATUS_ORDER: TodoStatus[] = ["in_progress", "pending", "done", "cancelled"];

const STATUS_ICONS: Record<TodoStatus, string> = {
	in_progress: "⏳",
	pending: "⬜",
	done: "✅",
	cancelled: "❌",
};

/**
 * Render compacto de una lista de to-dos (spec §5.3): header opcional
 * `To-dos N/M` (N = done+cancelled, M = total) + una línea por ítem.
 * Orden: in_progress → pending → done → cancelled; dentro de cada bloque,
 * orden de inserción. Texto plano SIN fence de código.
 */
export function formatTodoList(items: TodoItem[]): string {
	if (items.length === 0) return "To-dos: (vacía)";
	const closed = items.filter((i) => i.status === "done" || i.status === "cancelled").length;
	const lines = [`To-dos ${closed}/${items.length}`];
	for (const status of STATUS_ORDER) {
		for (const item of items) {
			if (item.status !== status) continue;
			let line = `${STATUS_ICONS[status]} ${item.id} ${item.text}`;
			if (status === "in_progress" && item.note) line += ` — ${item.note}`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}

/**
 * Store in-memory de to-dos. Un solo store por sesión de pi (lo crea
 * `installTodos`). El reloj es inyectable para tests del throttle.
 */
export function createTodoStore(now?: () => number) {
	// NB: default param NO declarado en la firma — el type-stripping de Node 22
	// pierde los defaults cuando la anotación es una función flecha.
	const clock = now ?? Date.now;
	// Map preserva orden de inserción = orden base definido por set_todos.
	const items = new Map<string, TodoItem>();
	// Último emit (por cualquier causa: set_todos, status, note-no-throttled)
	// por id — referencia del throttle de notes.
	const lastEmit = new Map<string, number>();

	function render(): string {
		return formatTodoList([...items.values()]);
	}

	/** Resetea el timer de throttle de notes de todos los ids vivos. */
	function markEmitted(at: number): void {
		for (const id of items.keys()) lastEmit.set(id, at);
	}

	return {
		render,

		snapshot(): TodoItem[] {
			return [...items.values()].map((i) => ({ ...i }));
		},

		/** `session_start`: lista a vacía, sin reconstrucción desde historial. */
		reset(): void {
			items.clear();
			lastEmit.clear();
		},

		/** set_todos: reemplaza la lista COMPLETA. Valida el lote entero antes de mutar. */
		replace(next: Array<{ id: string; text: string }>): TodoUpdateResult {
			if (!Array.isArray(next)) throw new Error("set_todos: items debe ser un array");
			if (next.length > MAX_ITEMS) {
				throw new Error(`set_todos: máximo ${MAX_ITEMS} ítems (mandaste ${next.length}) — lote rechazado entero, no truncado`);
			}
			const seen = new Set<string>();
			for (const raw of next) {
				const id = typeof raw?.id === "string" ? raw.id : "";
				if (id === "") throw new Error("set_todos: todo ítem necesita un id string no vacío");
				if (seen.has(id)) throw new Error(`set_todos: id duplicado "${id}"`);
				seen.add(id);
			}
			// Recién acá mutamos: un lote inválido no deja estado a medias.
			items.clear();
			lastEmit.clear();
			for (const raw of next) {
				items.set(raw.id, { id: raw.id, text: String(raw.text ?? ""), status: "pending" });
			}
			markEmitted(clock()); // set_todos SIEMPRE emite + resetea el timer de notes
			return { rendered: render(), emitted: true };
		},

		/**
		 * update_todo por id: status y/o note (al menos uno).
		 * - status presente (aunque sea igual al actual — idempotente) →
		 *   SIEMPRE emite y resetea el timer de note de ese id.
		 * - note-only → emite solo si pasaron ≥ NOTE_THROTTLE_MS desde el
		 *   último emit de ESE id; si no, aplica la note internamente y
		 *   devuelve { throttled: true, emitted: false }.
		 */
		update(id: string, patch: { status?: string; note?: string }): TodoUpdateResult {
			const item = items.get(id);
			if (!item) throw new Error(`update_todo: id desconocido "${id}"`);
			const hasStatus = patch.status !== undefined;
			const hasNote = patch.note !== undefined;
			if (!hasStatus && !hasNote) throw new Error("update_todo: mandá al menos status o note (no-op ambiguo)");

			if (hasStatus && !STATUS_ORDER.includes(patch.status as TodoStatus)) {
				throw new Error(`update_todo: status inválido "${patch.status}" (pending|in_progress|done|cancelled)`);
			}

			let note = item.note;
			if (hasNote) {
				const trimmed = String(patch.note).trim();
				note = trimmed.length > MAX_NOTE_LEN ? trimmed.slice(0, MAX_NOTE_LEN) : trimmed;
				if (note === "") note = undefined; // note vacía tras trim = sin note
			}

			item.status = hasStatus ? (patch.status as TodoStatus) : item.status;
			item.note = note;

			if (hasStatus) {
				lastEmit.set(id, clock());
				return { rendered: render(), emitted: true };
			}
			const t = clock();
			const last = lastEmit.get(id);
			if (last !== undefined && t - last < NOTE_THROTTLE_MS) {
				return { rendered: render(), emitted: false, throttled: true };
			}
			lastEmit.set(id, t);
			return { rendered: render(), emitted: true };
		},
	};
}

const StatusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("cancelled")],
	{ description: "pending | in_progress | done | cancelled (transiciones libres; múltiples in_progress permitidos)" },
);

/** Wiring testeable: inyectá un `pi` mock. */
export function installTodos(pi: ExtensionAPI): void {
	const store = createTodoStore();

	pi.on("session_start", () => store.reset());

	pi.registerTool({
		name: "set_todos",
		label: "To-dos",
		description:
			"Reemplaza la lista COMPLETA de to-dos del agente. Declarala al arrancar toda tarea de más de 2 pasos; " +
			"items: [] limpia la lista (clear válido). Máx 15 ítems; ids string únicos y no vacíos (batch inválido se rechaza entero); " +
			"status inicial de todo ítem: pending. Siempre emite el render compacto.",
		promptSnippet: "Declarar/reemplazar la lista de to-dos del agente (set_todos) y actualizarla (update_todo)",
		promptGuidelines: [
			"Toda tarea de más de 2 pasos declara sus to-dos al arrancar con set_todos y actualiza con update_todo al completar cada paso; el ítem in_progress lleva en note qué está pasando ahora.",
			"Emite el bloque compacto (el formato de esta tool) como TEXTO assistant — no solo como tool result — en cada cambio de estado. NO re-emitir cada 20 s ni en cada tool call; las notes van por el throttle de la tool.",
		],
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					id: Type.String({ description: "identificador corto y estable (lo referencia update_todo)" }),
					text: Type.String({ description: "qué hay que hacer (imperativo, una línea)" }),
				}),
				{ description: "lista COMPLETA (reemplaza la anterior); [] = clear" },
			),
		}),
		async execute(_toolCallId: string, params: { items: Array<{ id: string; text: string }> }) {
			const res = store.replace(params.items);
			return {
				content: [{ type: "text" as const, text: `${res.rendered}\n{ emitted: true }` }],
				details: { emitted: true, todos: store.snapshot() },
			};
		},
	});

	pi.registerTool({
		name: "update_todo",
		label: "Actualizar to-do",
		description:
			"Actualiza un to-do por id: status (pending|in_progress|done|cancelled; múltiples in_progress permitidos, sin autoswitch) " +
			"y/o note (trim, máx 80 chars, truncada si excede; visible solo en in_progress). " +
			"Cambio de status SIEMPRE emite; note-only está sujeta a throttle de 60 s por id (se aplica igual internamente). " +
			"Al menos uno de status/note es obligatorio.",
		parameters: Type.Object({
			id: Type.String({ description: "id del ítem (el declarado en set_todos)" }),
			status: Type.Optional(StatusSchema),
			note: Type.Optional(Type.String({ description: "nota corta: qué está pasando ahora en ese ítem (trim; máx 80 chars)" })),
		}),
		async execute(_toolCallId: string, params: { id: string; status?: string; note?: string }) {
			const res = store.update(params.id, { status: params.status, note: params.note });
			// Path throttled: no re-mandar la lista (gasto de contexto; hallazgo k3).
			// La note igual queda en details.todos para inspección.
			const text = res.emitted
				? `${res.rendered}\n{ emitted: true }`
				: "{ throttled: true, emitted: false }";
			return {
				content: [{ type: "text" as const, text }],
				details: { emitted: res.emitted, throttled: Boolean(res.throttled), todos: store.snapshot() },
			};
		},
	});
}

export default function (pi: ExtensionAPI): void {
	installTodos(pi);
}
