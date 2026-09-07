// -----------------------------------------------------------------------------
// Bounded, redacting serialiser for the request logger. The logger appends the
// JSON response body of every /api call to its stdout line, which reaches the
// Fly log stream and any configured drain — so it must never carry a secret
// (the login password arrives in a request body and must never be echoed), and
// it must cost O(cap) per request, not O(body): an export response can be
// multi-megabyte, and a full JSON.stringify of it on every request is wasted
// work even before the truncation.
// -----------------------------------------------------------------------------

const SECRET_KEY = /^(token|password|apiKey|authorization|secret|bearer)$/i;
const STRING_CLIP = 120; // per-string cap, applied BEFORE serialisation

/** Serialise `body` for a log line: secret keys replaced with "[redacted]",
 * long strings clipped before they are stringified, and the walk ABANDONED the
 * moment the output budget is reached — a multi-MB blob costs one slice. */
export function serializeForLog(body: unknown, cap = 500): string {
  const parts: string[] = [];
  let len = 0;
  let truncated = false;
  const push = (s: string): void => {
    if (truncated) return;
    if (len + s.length > cap) { truncated = true; return; }
    parts.push(s);
    len += s.length;
  };
  const walk = (v: unknown): void => {
    if (truncated) return;
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") {
      push(JSON.stringify(v ?? null));
      return;
    }
    if (typeof v === "string") {
      push(JSON.stringify(v.length > STRING_CLIP ? v.slice(0, STRING_CLIP) + "…" : v));
      return;
    }
    if (Array.isArray(v)) {
      push("[");
      for (let i = 0; i < v.length && !truncated; i++) {
        if (i) push(",");
        walk(v[i]);
      }
      push("]");
      return;
    }
    if (typeof v === "object") {
      push("{");
      let first = true;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (truncated) break;
        if (!first) push(",");
        first = false;
        push(JSON.stringify(k) + ":");
        if (SECRET_KEY.test(k)) push('"[redacted]"');
        else walk(val);
      }
      push("}");
      return;
    }
    push('"?"'); // functions/symbols — never expected in a res.json body
  };
  try {
    walk(body);
  } catch {
    return "[unserialisable]";
  }
  return parts.join("") + (truncated ? `…[truncated at ${cap} chars]` : "");
}
