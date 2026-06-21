// Extract a JSON object from model output that may be wrapped in prose or ``` fences.
// Used to parse structured results from CLI adapters (claude `result` field, etc).

export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  // strip a single fenced block if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  // grab the outermost {...}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}
