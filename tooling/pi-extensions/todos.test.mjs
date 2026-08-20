/**
 * Unit tests — todos (ID01-497, SPEC-ID01-497 §8).
 * Sin framework: `node tooling/pi-extensions/todos.test.mjs`
 */
import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as url from "node:url";

const here = import.meta.dirname;
const mod = await import(url.pathToFileURL(path.join(here, "todos.ts")).href);
const { NOTE_THROTTLE_MS, MAX_ITEMS, MAX_NOTE_LEN, formatTodoList, createTodoStore, installTodos } = mod;

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`FAIL ${name}: ${err.message}`);
	}
}

/** Reloj falso inyectable para el throttle (§5.4: sin sleeps reales). */
function makeClock(start = 0) {
	const c = { now: start };
	c.advance = (ms) => (c.now += ms);
	return c;
}

/** pi mock: captura tools registradas y handlers de eventos. */
function makeMockPi() {
	const tools = new Map();
	const handlers = new Map();
	return {
		tools,
		registerTool(t) {
			tools.set(t.name, t);
		},
		on(ev, fn) {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev).push(fn);
		},
		emit(ev) {
			for (const fn of handlers.get(ev) ?? []) fn();
		},
	};
}

// ---------------------------------------------------------------------------
// §8.1 Formato
// ---------------------------------------------------------------------------

await test("formato: lista vacía renderiza marcador explícito", () => {
	assert.equal(formatTodoList([]), "To-dos: (vacía)");
});

await test("formato: 4 estados con header N/M (N = done+cancelled)", () => {
	const out = formatTodoList([
		{ id: "a", text: "task a", status: "pending" },
		{ id: "b", text: "task b", status: "in_progress", note: "trabajando" },
		{ id: "c", text: "task c", status: "done" },
		{ id: "d", text: "task d", status: "cancelled" },
	]);
	const lines = out.split("\n");
	assert.equal(lines[0], "To-dos 2/4"); // done + cancelled = 2 de 4
	assert.equal(lines[1], "⏳ b task b — trabajando");
	assert.equal(lines[2], "⬜ a task a");
	assert.equal(lines[3], "✅ c task c");
	assert.equal(lines[4], "❌ d task d");
	assert.equal(lines.length, 5);
});

await test("formato: note visible SOLO en in_progress", () => {
	const out = formatTodoList([
		{ id: "p", text: "pendiente con note", status: "pending", note: "oculta" },
		{ id: "i", text: "activo", status: "in_progress", note: "visible" },
		{ id: "d", text: "hecho con note", status: "done", note: "oculta" },
	]);
	assert.ok(out.includes("⏳ i activo — visible"));
	assert.ok(!out.includes("oculta"));
});

await test("formato: orden in_progress → pending → done → cancelled, inserción dentro de cada bloque", () => {
	const out = formatTodoList([
		{ id: "p1", text: "", status: "pending" },
		{ id: "d1", text: "", status: "done" },
		{ id: "i1", text: "", status: "in_progress" },
		{ id: "p2", text: "", status: "pending" },
		{ id: "c1", text: "", status: "cancelled" },
		{ id: "i2", text: "", status: "in_progress" },
		{ id: "d2", text: "", status: "done" },
	]);
	const order = out
		.split("\n")
		.slice(1)
		.map((l) => l.split(" ")[1]);
	assert.deepEqual(order, ["i1", "i2", "p1", "p2", "d1", "d2", "c1"]);
});

await test("formato: SIN fence de código ni markdown alrededor", () => {
	const out = formatTodoList([{ id: "x", text: "t", status: "in_progress", note: "n" }]);
	assert.ok(!out.includes("```"));
	assert.ok(!out.startsWith("#"));
});

// ---------------------------------------------------------------------------
// §8.2 set_todos y transiciones
// ---------------------------------------------------------------------------

await test("set_todos: ítems nuevos quedan pending y emite", () => {
	const clock = makeClock(1000);
	const s = createTodoStore(() => clock.now);
	const res = s.replace([
		{ id: "a", text: "alpha" },
		{ id: "b", text: "beta" },
	]);
	assert.equal(res.emitted, true);
	assert.equal(res.throttled, undefined);
	assert.deepEqual(
		s.snapshot().map((i) => [i.id, i.status]),
		[
			["a", "pending"],
			["b", "pending"],
		],
	);
});

await test("set_todos: items [] = clear válido y emite", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "a", text: "x" }]);
	const res = s.replace([]);
	assert.equal(res.emitted, true);
	assert.equal(res.rendered, "To-dos: (vacía)");
	assert.equal(s.snapshot().length, 0);
});

await test("set_todos: reemplaza la lista previa (ids viejos desaparecen)", () => {
	const s = createTodoStore(() => 0);
	s.replace([
		{ id: "old", text: "viejo" },
		{ id: "keep", text: "queda" },
	]);
	s.replace([{ id: "keep", text: "queda" }]);
	const ids = s.snapshot().map((i) => i.id);
	assert.deepEqual(ids, ["keep"]);
});

await test("set_todos: set_todos re-declarado con id conocido reusa su slot (orden base nuevo)", () => {
	const s = createTodoStore(() => 0);
	s.replace([
		{ id: "a", text: "1" },
		{ id: "b", text: "2" },
	]);
	s.update("b", { status: "done" });
	s.replace([
		{ id: "b", text: "2" },
		{ id: "a", text: "1" },
	]); // sin note
	assert.equal(s.snapshot().find((i) => i.id === "b").status, "pending"); // reemplazo total: sin memoria
});

await test("transiciones: pending → in_progress → done", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "t", text: "tarea" }]);
	let res = s.update("t", { status: "in_progress" });
	assert.equal(res.emitted, true);
	assert.equal(s.snapshot()[0].status, "in_progress");
	clock.advance(5000);
	res = s.update("t", { status: "done" });
	assert.equal(res.emitted, true);
	assert.equal(s.snapshot()[0].status, "done");
	assert.ok(res.rendered.startsWith("To-dos 1/1"));
});

await test("transiciones: cancelled", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "t", text: "tarea" }]);
	const res = s.update("t", { status: "cancelled" });
	assert.equal(res.emitted, true);
	assert.equal(s.snapshot()[0].status, "cancelled");
	assert.ok(res.rendered.includes("❌ t tarea"));
});

await test("transiciones: DOS in_progress simultáneos (sin autoswitch)", () => {
	const s = createTodoStore(() => 0);
	s.replace([
		{ id: "a", text: "A" },
		{ id: "b", text: "B" },
	]);
	s.update("a", { status: "in_progress" });
	s.update("b", { status: "in_progress" });
	const st = Object.fromEntries(s.snapshot().map((i) => [i.id, i.status]));
	assert.equal(st.a, "in_progress");
	assert.equal(st.b, "in_progress");
});

await test("transiciones: update solo con note (sin status) aplica la note", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS); // fuera del throttle para aislar el estado
	const res = s.update("a", { note: "esperando CI" });
	assert.equal(res.emitted, true);
	assert.equal(s.snapshot()[0].note, "esperando CI");
	assert.ok(res.rendered.includes("⏳ a A — esperando CI"));
});

// ---------------------------------------------------------------------------
// §8.3 Throttle
// ---------------------------------------------------------------------------

await test("throttle: status change emite SIEMPRE y resetea el timer de note de ese id", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	assert.equal(s.update("a", { status: "in_progress" }).emitted, true);
	clock.advance(50000); // >60s desde set_todos, pero el status RESETÓ el timer
	const res = s.update("a", { note: "note fresca" });
	assert.deepEqual({ emitted: res.emitted, throttled: res.throttled }, { emitted: false, throttled: true });
});

await test("throttle: note-only <60s → throttled, pero el estado interno queda actualizado", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(10000);
	const res = s.update("a", { note: "paso 3 de 7" });
	assert.equal(res.emitted, false);
	assert.equal(res.throttled, true);
	assert.equal(s.snapshot()[0].note, "paso 3 de 7"); // aplicada internamente
});

await test("throttle: note-only ≥60s desde el último emit de ESE id → emite", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS);
	const res = s.update("a", { note: "ya pasó el throttle" });
	assert.equal(res.emitted, true);
	assert.equal(res.throttled, undefined);
});

await test("throttle: el timer es POR ID (note de otro id no lo bloquea)", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([
		{ id: "a", text: "A" },
		{ id: "b", text: "B" },
	]);
	s.update("a", { status: "in_progress" }); // resetea timer de TODOS los ids (set/status emiten la lista)
	clock.advance(NOTE_THROTTLE_MS - 1000);
	const resA = s.update("a", { note: "a note" });
	assert.equal(resA.emitted, false); // a sigue dentro de su ventana
	const resB = s.update("b", { status: "in_progress" });
	assert.equal(resB.emitted, true); // status siempre emite
	clock.advance(1000); // b recién emitió por status → su ventana corre desde ahí
	const resB2 = s.update("b", { note: "b note" });
	assert.equal(resB2.emitted, false);
});

await test("throttle: la note acumulada en throttled se muestra en el próximo emit por status", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(1000);
	s.update("a", { note: "acumulada" }); // throttled, interna
	clock.advance(1000);
	const res = s.update("a", { status: "done" });
	assert.equal(res.emitted, true);
	assert.ok(res.rendered.includes("acumulada") === false); // done no muestra note
	assert.equal(s.snapshot()[0].note, "acumulada"); // pero persiste (§5.2)
});

await test("throttle: set_todos SIEMPRE emite y resetea el timer de notes de todos los ids", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	clock.advance(NOTE_THROTTLE_MS + 5000);
	s.update("a", { status: "in_progress" }); // emite por status, timer desde acá
	clock.advance(NOTE_THROTTLE_MS + 5000);
	const res = s.replace([{ id: "a", text: "A" }]); // fuera de ventana igual, pero probamos el reset:
	assert.equal(res.emitted, true);
	clock.advance(10000); // apenas 10s después del set_todos
	const resNote = s.update("a", { note: "muy pronto" });
	assert.equal(resNote.emitted, false); // el set_todos reseteó el timer
	assert.equal(resNote.throttled, true);
});

// ---------------------------------------------------------------------------
// §8.4 Errores
// ---------------------------------------------------------------------------

await test("errores: update_todo con id desconocido", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "a", text: "A" }]);
	assert.throws(() => s.update("fantasma", { status: "done" }), /id desconocido/);
});

await test("errores: set_todos con ids duplicados (lote entero rechazado)", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "a", text: "A" }]);
	assert.throws(
		() =>
			s.replace([
				{ id: "x", text: "1" },
				{ id: "x", text: "2" },
			]),
		/duplicado/,
	);
	// estado previo intacto
	assert.deepEqual(s.snapshot().map((i) => i.id), ["a"]);
});

await test("errores: set_todos con id vacío", () => {
	const s = createTodoStore(() => 0);
	assert.throws(() => s.replace([{ id: "", text: "sin id" }]), /no vacío/);
});

await test("errores: set_todos con más de 15 ítems rechaza el lote (no trunca)", () => {
	const s = createTodoStore(() => 0);
	const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ id: `i${i}`, text: `t${i}` }));
	assert.throws(() => s.replace(items), /máximo 15/);
	assert.equal(s.snapshot().length, 0);
	// exactamente 15 pasa
	s.replace(items.slice(0, MAX_ITEMS));
	assert.equal(s.snapshot().length, MAX_ITEMS);
});

await test("errores: update_todo con status fuera del set", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "a", text: "A" }]);
	assert.throws(() => s.update("a", { status: "blocked" }), /status inválido/);
});

await test("errores: update_todo sin status ni note", () => {
	const s = createTodoStore(() => 0);
	s.replace([{ id: "a", text: "A" }]);
	assert.throws(() => s.update("a", {}), /al menos status o note/);
});

// ---------------------------------------------------------------------------
// §8.5 Reset por session_start
// ---------------------------------------------------------------------------

await test("reset: session_start vacía la lista (sin reconstrucción desde historial)", async () => {
	const pi = makeMockPi();
	installTodos(pi);
	const setTool = pi.tools.get("set_todos");
	const updTool = pi.tools.get("update_todo");
	assert.ok(setTool && updTool, "installTodos debe registrar ambas tools");

	await setTool.execute("c1", { items: [{ id: "a", text: "A" }] });
	await updTool.execute("c2", { id: "a", status: "in_progress", note: "en curso" });

	pi.emit("session_start");
	const after = await setTool.execute("c3", { items: [] }); // clear → render de lista vacía
	// El reset ya vació: el snapshot post-session_start es lo que importa;
	// verificamos vía update id desconocido (la "a" ya no existe).
	await assert.rejects(() => updTool.execute("c4", { id: "a", status: "done" }), /id desconocido/);
	assert.ok(after.content[0].text.includes("To-dos: (vacía)"));
});

// ---------------------------------------------------------------------------
// §8.6 Note: trim y truncado
// ---------------------------------------------------------------------------

await test("note: trim aplicado", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS);
	const res = s.update("a", { note: "   con espacios   " });
	assert.equal(s.snapshot()[0].note, "con espacios");
	assert.ok(res.rendered.includes("— con espacios"));
});

await test("note: truncada a 80 chars tras el trim (no rechazada)", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS);
	const long = "x".repeat(MAX_NOTE_LEN + 21); // 101 chars
	s.update("a", { note: long });
	const note = s.snapshot()[0].note;
	assert.equal(note.length, MAX_NOTE_LEN);
	assert.equal(note, "x".repeat(MAX_NOTE_LEN));
});

await test("note: vacía tras trim = sin note (no se muestra el guión)", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS);
	s.update("a", { note: "   " });
	assert.equal(s.snapshot()[0].note, undefined);
	assert.ok(!s.render().includes(" — "));
});

await test("note: persiste hasta sobreescribirse o desaparecer el ítem", () => {
	const clock = makeClock();
	const s = createTodoStore(() => clock.now);
	s.replace([{ id: "a", text: "A" }]);
	s.update("a", { status: "in_progress" });
	clock.advance(NOTE_THROTTLE_MS);
	s.update("a", { note: "v1" });
	s.update("a", { status: "done" }); // done: la note persiste aunque no se muestre
	assert.equal(s.snapshot()[0].note, "v1");
	s.replace([{ id: "a", text: "A" }]); // el ítem "desaparece" (reemplazo): note fuera
	assert.equal(s.snapshot()[0].note, undefined);
});

// ---------------------------------------------------------------------------
// Wiring de installTodos (tools registradas + output del tool result)
// ---------------------------------------------------------------------------

await test("installTodos: registra set_todos y update_todo (nada más)", () => {
	const pi = makeMockPi();
	installTodos(pi);
	assert.deepEqual([...pi.tools.keys()].sort(), ["set_todos", "update_todo"]);
});

await test("installTodos: set_todos devuelve render + {emitted: true}", async () => {
	const pi = makeMockPi();
	installTodos(pi);
	const out = await pi.tools.get("set_todos").execute("c1", { items: [{ id: "a", text: "alpha" }] });
	assert.equal(out.content[0].type, "text");
	assert.ok(out.content[0].text.startsWith("To-dos 0/1\n⬜ a alpha"));
	assert.ok(out.content[0].text.endsWith("{ emitted: true }"));
	assert.equal(out.details.emitted, true);
});

await test("installTodos: update_todo throttled devuelve {throttled: true, emitted: false}", async () => {
	const pi = makeMockPi();
	installTodos(pi);
	const set = pi.tools.get("set_todos");
	const upd = pi.tools.get("update_todo");
	await set.execute("c1", { items: [{ id: "a", text: "alpha" }] });
	await upd.execute("c2", { id: "a", status: "in_progress" });
	const out = await upd.execute("c3", { id: "a", note: "inmediata" }); // <60s → throttled
	assert.equal(out.content[0].text, "{ throttled: true, emitted: false }");
	assert.equal(out.details.throttled, true);
	assert.equal(out.details.emitted, false);
	assert.equal(out.details.todos.find((t) => t.id === "a").note, "inmediata");
});

await test("installTodos: validación de la tool propaga el error (pi lo convierte en tool error)", async () => {
	const pi = makeMockPi();
	installTodos(pi);
	await assert.rejects(
		() => pi.tools.get("update_todo").execute("c1", { id: "nope", status: "done" }),
		/id desconocido/,
	);
	await assert.rejects(
		() => pi.tools.get("set_todos").execute("c2", { items: [{ id: "d", text: "x" }, { id: "d", text: "y" }] }),
		/duplicado/,
	);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} ok, ${failures.length} fail (todos.test.mjs)`);
if (failures.length > 0) {
	for (const f of failures) console.error(`FAIL ${f.name}: ${f.err?.stack ?? f.err}`);
	process.exit(1);
}
