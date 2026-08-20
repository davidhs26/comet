/**
 * edit-coach — enriquece el error de mismatch del tool built-in `edit` (ID01-453).
 *
 * Vía elegida (ver INVESTIGACION-EDIT.md): (a)+(b). `createEditToolDefinition` es
 * importable (dist/index.js:24) y `registerTool({name:"edit"})` REEMPLAZA al
 * built-in en el registry (agent-session.js:1990-1993, extensiones pisan por
 * nombre). La extensión registra una tool `edit` que delega TODO en la
 * definición built-in real (creada perezosamente por cwd) y solo wrappea
 * `execute`: si el edit tiene éxito, el resultado es INTACTO; si falla por
 * mismatch de oldText ("Could not find …", edit-diff.js:186-189), se lee el
 * archivo, se corre edit-core.findClosestMatch y se re-lanza el error con el
 * mensaje original + excerpt real + mini-diff + hint. El agent loop convierte
 * ese throw en el tool result de error de siempre (agent-loop.js:472-479).
 *
 * NUNCA auto-aplica el match aproximado. Si edit-core o la lectura del archivo
 * fallan, se degrada al mensaje de error original (nunca empeorar el caso base).
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildCoachMessage, findClosestMatch } from "./edit-core.mjs";

type EditParams = {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
};

// El built-in cierra sobre `cwd` (dist/core/tools/edit.js:168-182): una por cwd.
const innerByCwd = new Map<string, ToolDefinition<any, any, any>>();

function getInner(cwd: string): ToolDefinition<any, any, any> {
	let inner = innerByCwd.get(cwd);
	if (!inner) {
		inner = createEditToolDefinition(cwd);
		innerByCwd.set(cwd, inner);
	}
	return inner;
}

/**
 * Mensajes de mismatch del built-in (dist/core/tools/edit-diff.js:186-189):
 * - 1 edit:  "Could not find the exact text in <path>. The old text must match exactly…"
 * - N edits: "Could not find edits[<i>] in <path>. The oldText must match exactly…"
 * Los errores de "Found N occurrences…" (texto no único) NO se tocan.
 */
const MISMATCH_RE = /^Could not find (?:the exact text|edits\[(\d+)\]) in /;

function parseMismatchIndex(message: string): number | null {
	const m = MISMATCH_RE.exec(message);
	if (!m) return null;
	return m[1] !== undefined ? Number(m[1]) : 0;
}

/**
 * Si `err` es un mismatch de oldText, devuelve un Error enriquecido con el
 * closest match real. Ante CUALQUIER problema (no es mismatch, archivo
 * ilegible, edit-core explota) devuelve `err` intacto.
 */
async function maybeEnrichError(err: unknown, params: EditParams, cwd: string): Promise<unknown> {
	if (!(err instanceof Error)) return err;
	const editIndex = parseMismatchIndex(err.message);
	if (editIndex === null) return err;
	try {
		const oldText = params?.edits?.[editIndex]?.oldText;
		if (typeof oldText !== "string" || typeof params?.path !== "string") return err;
		const absolutePath = path.resolve(cwd, params.path);
		const fileContent = await readFile(absolutePath, "utf8");
		const result = findClosestMatch(fileContent, oldText);
		return new Error(buildCoachMessage(err.message, result, { path: params.path }));
	} catch {
		return err;
	}
}

export default function (pi: ExtensionAPI): void {
	// Metadata estática (name/label/description/schema/snippets) no depende del
	// cwd — edit.js:171-178. Se toma de un template; el execute/render real
	// delega en la definición built-in del cwd de cada llamada.
	const template = getInner(process.cwd());

	pi.registerTool({
		name: template.name, // "edit" — reemplaza al built-in (agent-session.js:1990-1993)
		label: template.label,
		description: template.description,
		promptSnippet: template.promptSnippet,
		promptGuidelines: template.promptGuidelines,
		parameters: template.parameters,
		constrainedSampling: template.constrainedSampling,
		renderShell: template.renderShell,
		// prepareEditArguments es puro (cwd-independiente, edit.js:38-60).
		prepareArguments: (args: unknown) => template.prepareArguments!(args) as EditParams,
		async execute(toolCallId, params: EditParams, signal, onUpdate, ctx: ExtensionContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const inner = getInner(cwd);
			try {
				return await inner.execute(toolCallId, params, signal, onUpdate, ctx);
			} catch (err) {
				throw await maybeEnrichError(err, params, cwd);
			}
		},
		renderCall: (args, theme, context) => getInner(context.cwd).renderCall!(args, theme, context),
		renderResult: (result, options, theme, context) =>
			getInner(context.cwd).renderResult!(result, options, theme, context),
	});
}
