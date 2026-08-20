/**
 * edit-core — lógica pura del "coach" de edits fallidos (ID01-453).
 *
 * Sin dependencias de pi: findClosestMatch/buildCoachMessage. La extensión
 * edit-coach.ts cablea esto al override del tool built-in `edit`
 * (ver INVESTIGACION-EDIT.md).
 *
 * Contrato:
 * - findClosestMatch(fileContent, oldString) escanea el archivo con una ventana
 *   del mismo tamaño (en líneas) que oldString y se queda con la ventana que
 *   maximiza el ratio de líneas comunes normalizadas. Empates → la PRIMERA
 *   ventana (determinista).
 * - Diagnósticos: "whitespace" | "indentation" | "content-drift" | "not-found"
 *   | "multiple-partial".
 * - JAMÁS se auto-aplica el match: solo se informa para que el modelo corrija.
 */

/** Cap del excerpt que se le muestra al modelo (bytes UTF-8). */
export const EXCERPT_CAP_BYTES = 2048;
/** Score mínimo (ratio de líneas comunes normalizadas) para considerar un candidato. */
export const MATCH_THRESHOLD = 0.5;
/** Cap de líneas para el mini-diff LCS (encima se cae a diff trivial). */
export const DIFF_MAX_LINES = 400;

/** Normaliza una línea para comparar: trim + colapsa runs de whitespace internos. */
function normalizeLine(line) {
	return line.trim().replace(/\s+/g, " ");
}

/** Split en líneas LF; si el texto termina en "\n", el "" final no cuenta como línea. */
function toLines(text) {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Escaneo por ventana de `oldLines.length` líneas sobre el archivo.
 * Score de una ventana: (# posiciones i con normalizeLine(w[i]) === normalizeLine(old[i])) / n.
 *
 * @param {string} fileContent contenido actual del archivo (LF o CRLF; se normaliza a LF)
 * @param {string} oldString el oldText que no matcheó
 * @returns {{
 *   found: boolean,
 *   lineStart: number, lineEnd: number,   // 1-based, inclusivos (0 si !found)
 *   score: number,
 *   excerpt: string,                      // líneas numeradas " 12 | …", cap 2KB
 *   diagnosis: "whitespace"|"indentation"|"content-drift"|"not-found"|"multiple-partial",
 *   miniDiff: string,                     // unified: oldString vs candidato
 *   candidateCount: number,               // ventanas empatadas en el mejor score >= threshold
 * }}
 */
export function findClosestMatch(fileContent, oldString) {
	const notFound = {
		found: false,
		lineStart: 0,
		lineEnd: 0,
		score: 0,
		excerpt: "",
		diagnosis: "not-found",
		miniDiff: "",
		candidateCount: 0,
	};
	if (typeof fileContent !== "string" || typeof oldString !== "string") return notFound;
	const normalizedFile = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const normalizedOld = oldString.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const oldLines = toLines(normalizedOld);
	const n = oldLines.length;
	if (n === 0 || normalizedOld.trim() === "") return notFound;
	const fileLines = toLines(normalizedFile);
	if (fileLines.length < n) {
		// El archivo entero es más corto que oldString: no hay ventana posible.
		return notFound;
	}
	const oldNorm = oldLines.map(normalizeLine);

	let bestScore = -1;
	let bestStart = 0; // 0-based
	let bestCount = 0;
	for (let start = 0; start + n <= fileLines.length; start++) {
		let common = 0;
		for (let i = 0; i < n; i++) {
			if (normalizeLine(fileLines[start + i]) === oldNorm[i]) common++;
		}
		const score = common / n;
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
			bestCount = 1;
		} else if (score === bestScore) {
			bestCount++;
		}
	}

	if (bestScore < MATCH_THRESHOLD) return notFound;

	const windowLines = fileLines.slice(bestStart, bestStart + n);
	const diagnosis = classify(oldLines, windowLines, bestCount);
	const lineStart = bestStart + 1;
	const lineEnd = bestStart + n;
	return {
		found: true,
		lineStart,
		lineEnd,
		score: bestScore,
		excerpt: buildExcerpt(windowLines, lineStart),
		diagnosis,
		miniDiff: buildMiniDiff(normalizedOld, windowLines.join("\n")),
		candidateCount: bestCount,
	};
}

/**
 * Clasifica por qué el candidato no fue match exacto.
 * Precondición: same length, score >= threshold, y NO son idénticos
 * (si fueran idénticos el edit no habría fallado por mismatch).
 */
function classify(oldLines, windowLines, candidateCount) {
	if (candidateCount > 1) return "multiple-partial";
	let allTrimStartEqual = true;
	let allNormEqual = true;
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i].trimStart() !== windowLines[i].trimStart()) allTrimStartEqual = false;
		if (normalizeLine(oldLines[i]) !== normalizeLine(windowLines[i])) {
			allNormEqual = false;
			break;
		}
	}
	if (allTrimStartEqual) return "indentation";
	if (allNormEqual) return "whitespace";
	return "content-drift";
}

/** Excerpt con números de línea, capped a EXCERPT_CAP_BYTES (UTF-8 safe). */
function buildExcerpt(windowLines, lineStart) {
	const width = String(lineStart + windowLines.length - 1).length;
	const raw = windowLines
		.map((line, i) => `${String(lineStart + i).padStart(width)} | ${line}`)
		.join("\n");
	const buf = Buffer.from(raw, "utf8");
	if (buf.length <= EXCERPT_CAP_BYTES) return raw;
	let end = EXCERPT_CAP_BYTES;
	// No partir un codepoint multibyte por la mitad
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return `${buf.subarray(0, end).toString("utf8")}\n[…excerpt truncado a ${EXCERPT_CAP_BYTES} bytes]`;
}

/**
 * Mini-diff unified entre oldString (lo que mandó el modelo) y el candidato
 * real del archivo. LCS por líneas; con más de DIFF_MAX_LINES líneas por lado
 * cae a un diff trivial (todo - / todo +) para no explotar la DP.
 */
export function buildMiniDiff(oldText, candidateText) {
	const a = toLines(oldText);
	const b = toLines(candidateText);
	const header = `--- oldText (lo que enviaste)\n+++ archivo (candidato real)\n`;
	if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
		return (
			header +
			a.map((l) => `-${l}`).join("\n") +
			"\n" +
			b.map((l) => `+${l}`).join("\n")
		);
	}
	// LCS DP
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			out.push(` ${a[i]}`);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push(`-${a[i]}`);
			i++;
		} else {
			out.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < m) out.push(`-${a[i++]}`);
	while (j < n) out.push(`+${b[j++]}`);
	return header + out.join("\n");
}

const HINTS = {
	indentation:
		"difiere SOLO en la indentación — copiá el oldText desde el excerpt de arriba tal cual (respetando los espacios iniciales) y reintentá el edit",
	whitespace:
		"difiere SOLO en whitespace (espacios internos o al final de línea) — copiá el oldText desde el excerpt de arriba, byte por byte, y reintentá el edit",
	"content-drift":
		"el contenido real difiere del que enviaste — el archivo cambió o lo recordás mal; reconstruí el oldText desde el excerpt (o releé el archivo) y reintentá",
	"multiple-partial":
		"hay varios bloques parcialmente iguales en el archivo — agregá más líneas de contexto único al oldText (o usá el excerpt de arriba como base) y reintentá",
	"not-found":
		"no hay ningún bloque parecido en el archivo — probablemente el contenido ya cambió (o el edit ya se aplicó); releé el archivo antes de reintentar",
};

/**
 * Arma el mensaje enriquecido para el modelo. `originalError` va primero para
 * no perder información; el bloque coach se agrega después.
 *
 * @param {string} originalError mensaje de error original del built-in edit
 * @param {ReturnType<typeof findClosestMatch>} result
 * @param {{path?: string}} [opts]
 * @returns {string}
 */
export function buildCoachMessage(originalError, result, opts = {}) {
	const where = opts.path ? ` en ${opts.path}` : "";
	if (!result.found) {
		return `${originalError}\n\n[edit-coach] No se encontró ningún bloque similar${where}.\nHint: ${HINTS["not-found"]}.`;
	}
	const pct = Math.round(result.score * 100);
	const parts = [
		originalError,
		"",
		`[edit-coach] Bloque más parecido${where} (líneas ${result.lineStart}-${result.lineEnd}, similitud ${pct}%${result.candidateCount > 1 ? `, ${result.candidateCount} candidatos empatados` : ""}):`,
		result.excerpt,
		"",
		"Diff (tu oldText vs el contenido real):",
		result.miniDiff,
		"",
		`Diagnóstico: ${result.diagnosis}. Hint: ${HINTS[result.diagnosis]}.`,
		"IMPORTANTE: no reintentés con el mismo oldText; corregílo usando el excerpt real de arriba.",
	];
	return parts.join("\n");
}
