import crypto from "node:crypto";

export const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

// Returns "write" | "read" | null for the presented key. Write is checked first so a legacy
// single key that is both read and write resolves to write.
export function accessLevel(store, presented) {
  if (store.writeSecret && safeEq(presented, store.writeSecret)) return "write";
  if (store.readSecret && safeEq(presented, store.readSecret)) return "read";
  return null;
}

// Returns "query" | "mutation" | "subscription" | null for the first operation keyword.
export function opType(doc) {
  const stripped = doc.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, "").trim();
  if (stripped.startsWith("{")) return "query";
  const m = stripped.match(/^(query|mutation|subscription)\b/);
  return m ? m[1] : null;
}

// Mutation fields refused even with a write key (whole-word, case-sensitive match on the document).
export const BLOCKED_MUTATIONS = /\b(themePublish|themeDelete|appUninstall|appRevokeAccessScopes|refundCreate|orderCancel|orderCapture|giftCardCreate|giftCardUpdate|staffMemberDelete|shopLocaleDisable)\b/;
export const hasMutation = (doc) => /(^|[\s}])mutation\b/.test(doc.replace(/#[^\n]*/g, ""));
