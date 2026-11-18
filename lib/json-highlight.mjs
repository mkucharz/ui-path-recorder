/**
 * JSON, coloured — at build time, with no script on the page.
 *
 * The site's plan block is the one piece of source a reader is asked to *read*: a
 * plan is the artefact this tool wants committed, so the page shows one. Plain
 * grey text makes a reader pick `"shot"` and `"expect"` out of a wall of quoted
 * words; the point of colouring it is that the vocabulary of a step — the keys —
 * can be found by eye.
 *
 * It runs in the build rather than in the browser on purpose. The page says it is
 * HTML, a stylesheet and one script that opens a recording, and a highlighter
 * shipped to the reader would be a second script, a second parse of text the build
 * already has, and a flash of unhighlighted code before it ran. Here the spans are
 * in the file Pages serves.
 *
 * The colour is the palette's, not a theme's: keys take the page's one saturated
 * colour, `${…}` takes it too (a variable is the thing worth spotting), numbers
 * and literals take the brightest ink, punctuation recedes. Strings stay the
 * body's own colour, so a plan reads as text with structure rather than confetti.
 */

/** `${NAME}` is interpolation, not text — `lib/plan.mjs` resolves it at run time. */
const INTERPOLATION = /\$\{[^}]*\}/g;

/**
 * One pass over the source.
 *
 * Strings are matched first and swallow everything inside them, which is what
 * keeps a `true` inside a caption from being coloured as a literal and a number
 * inside `"#form-2"` from being coloured as a number.
 */
const TOKEN = /"(?:\\[^]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

/**
 * Everything here is written into a `<code>` element, not an attribute, so only
 * the three characters that can change the parse are escaped. A quote is text on
 * this side of the tag, and leaving it alone keeps the served HTML readable.
 */
const escapeText = (value) =>
  String(value ?? '').replace(
    /[&<>]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char],
  );

/** The braces and commas of a nested object should not compete with its keys. */
const dimPunctuation = (text) =>
  escapeText(text).replace(/[{}[\],:]/g, (char) => `<span class="j-p">${char}</span>`);

/**
 * A string, with any `${…}` inside it marked as interpolation.
 *
 * Every string is wrapped, with or without interpolation: one token, one rule. A
 * plain string already reads as body text because that is the colour `.j-s`
 * carries — the span is what lets a variable sit *inside* it without the two
 * rules disagreeing about which one wins.
 */
function stringToken(raw, isKey) {
  if (isKey) return `<span class="j-k">${escapeText(raw)}</span>`;
  const body = raw.slice(1, -1);
  const marks = [...body.matchAll(INTERPOLATION)];
  if (!marks.length) return `<span class="j-s">${escapeText(raw)}</span>`;
  // Re-woven by hand: `split` drops the separators, so the parts and the marks
  // are two lists that interleave.
  const parts = body.split(INTERPOLATION);
  let inner = '';
  for (let index = 0; index < marks.length; index += 1) {
    inner += escapeText(parts[index]) + `<span class="j-v">${escapeText(marks[index][0])}</span>`;
  }
  inner += escapeText(parts[parts.length - 1]);
  return `<span class="j-s">"${inner}"</span>`;
}

/**
 * `source` → the same text as HTML, with the tokens wrapped.
 *
 * The function is total: anything that is not a token is escaped and emitted, so
 * a half-written plan still renders as the text it is.
 */
export function highlightJson(source) {
  const text = String(source ?? '');
  let out = '';
  let cursor = 0;

  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    out += dimPunctuation(text.slice(cursor, match.index));
    cursor = match.index + raw.length;

    if (raw.startsWith('"')) {
      // A key is a string whose next non-space character is a colon. Eight
      // characters is enough to see `": {` through a newline's indentation.
      out += stringToken(raw, /^\s*:/.test(text.slice(cursor, cursor + 8)));
    } else if (/^(?:true|false|null)$/.test(raw)) {
      out += `<span class="j-l">${raw}</span>`;
    } else {
      out += `<span class="j-n">${raw}</span>`;
    }
  }

  return out + dimPunctuation(text.slice(cursor));
}

/**
 * The one block on the page that is highlighted, and the class that marks it.
 *
 * Shared because both ends need the same pattern: the build replaces it,
 * `scripts/check-site.mjs` refuses a template whose block is not valid JSON.
 */
export const PLAN_BLOCK = /<code class="json">([\s\S]*?)<\/code>/;
