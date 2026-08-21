// SPEC-ID01-502 §4.1-4.2 — gate + flatten de custom messages de pi.
// Función pura self-contained (cero imports, JS puro): recibe el objeto
// `message` de un evento `message_end` y devuelve el texto final a emitir
// como agent_message_chunk, o null cuando NO se emite.
//
// Este módulo es la ÚNICA fuente de verdad: tools/patch_piacp.mjs lo inlinea
// al dist del adapter leyendo este archivo en runtime, y los tests lo
// importan directo. No refactorizar la firma ni el nombre exportado sin
// actualizar el patch.

export function forwardCustomText(message) {
  // Gate §4.1: estricto — role custom, display === true (ni truthy), texto no vacío.
  if (message == null || typeof message !== "object") return null;
  if (message.role !== "custom") return null;
  if (message.display !== true) return null;

  // Flatten §4.2: string tal cual; array → solo items type "text", unidos con \n.
  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    const parts = [];
    for (const item of message.content) {
      if (item != null && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
      // imágenes y tipos desconocidos: se omiten silenciosamente (v1)
    }
    text = parts.join("\n");
  }
  if (text.trim().length === 0) return null;

  // Prefijo §4.2: "[{customType}]\n" solo si customType es string no vacío.
  const customType = typeof message.customType === "string" ? message.customType : "";
  return customType.length > 0 ? "[" + customType + "]\n" + text : text;
}
