/**
 * JSON, coloured at build time.
 *
 * The risk here is not "does it look nice" — that is a screenshot — it is that a
 * highlighter mangles the text it is showing. A plan is source; a page that
 * silently quotes it differently, or drops a `<`, is worse than a page with no
 * colour at all. So most of this file is one property: strip the spans, decode the
 * entities, and the block is byte-for-byte the file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightJson, PLAN_BLOCK } from '../lib/json-highlight.mjs';

const PLAN = `{
  "tutorial": "signin",
  "viewport": { "width": 1600, "height": 900 },
  "vars": { "email": { "literal": "admin@example.com" } },
  "steps": [
    { "name": "open", "goto": "/login" },
    { "name": "sign-in card", "clickIfPresent": { "selector": "#field-2" } },
    { "expect": { "selector": ["#email"] }, "shot": { "id": "01-signin" } }
  ]
}`;

/** What a reader sees: the spans removed, the entities put back. */
const asText = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

test('the coloured block is the source, character for character', () => {
  assert.equal(asText(highlightJson(PLAN)), PLAN);
});

test('a plan is JSON an agent writes, so quotes, angles and ampersands survive', () => {
  const awkward = '{"name":"Tom & Jerry <script>alert(1)</script>","n":1}';
  const html = highlightJson(awkward);
  assert.equal(asText(html), awkward);
  // Decoding alone would pass even if `&` were left bare, so the escaping itself
  // is asserted: every `&` in the source is `&amp;` in the output.
  assert.match(html, /Tom &amp; Jerry &lt;script&gt;/);
  assert.doesNotMatch(html.replace(/<\/?span[^>]*>/g, ''), /&(?!amp;|lt;|gt;)/);
  // Nothing in the output can open a tag the source did not describe.
  assert.doesNotMatch(html.replace(/<\/?span[^>]*>/g, ''), /<script>/);
});

test('a variable is escaped like the text around it, quotes and all', () => {
  const source = '{"baseUrl": "${A<B&C}", "note": "\\\\"quoted\\\\""}';
  const html = highlightJson(source);
  assert.equal(asText(html), source);
  assert.match(html, /<span class="j-v">\$\{A&lt;B&amp;C\}<\/span>/);
});

test('keys and strings are different things, and a colon decides which', () => {
  const html = highlightJson(PLAN);
  // The step vocabulary is what a reader scans for.
  assert.match(html, /<span class="j-k">"goto"<\/span>/);
  assert.match(html, /<span class="j-k">"shot"<\/span>/);
  // A value is not a key even though it is the same kind of token.
  assert.match(html, /<span class="j-s">"\/login"<\/span>/);
  assert.doesNotMatch(html, /<span class="j-k">"\/login"/);
  // The colon itself is dimmed, not styled like either side of it.
  assert.match(html, /<span class="j-p">:<\/span>/);
  // A key is a key however much room the author left before the colon.
  assert.match(highlightJson('{"a"        : 1}'), /<span class="j-k">"a"<\/span>/);
});

test('a number inside a string is a string, and a number is a number', () => {
  const html = highlightJson('{"width": 1600, "id": "field-2"}');
  assert.match(html, /<span class="j-n">1600<\/span>/);
  assert.match(html, /<span class="j-s">"field-2"<\/span>/);
  assert.doesNotMatch(html, /<span class="j-n">2<\/span>/);
});

test('true, false and null are literals; the same words in a caption are not', () => {
  const html = highlightJson('{"a": true, "b": null, "c": "true is a word"}');
  assert.equal((html.match(/class="j-l"/g) ?? []).length, 2);
  assert.match(html, /<span class="j-l">true<\/span>/);
  assert.match(html, /<span class="j-s">"true is a word"<\/span>/);
});

test('${…} is interpolation, so it is marked inside the string that holds it', () => {
  const html = highlightJson('{"baseUrl": "${INSTANCE_URL}", "n": "no var here"}');
  assert.match(html, /<span class="j-v">\$\{INSTANCE_URL\}<\/span>/);
  assert.match(html, /<span class="j-s">"<span class="j-v">\$\{INSTANCE_URL\}<\/span>"<\/span>/);
  // Only where there is one.
  const plain = highlightJson('{"n": "no var here"}');
  assert.doesNotMatch(plain, /class="j-v"/);
  assert.match(plain, /<span class="j-s">"no var here"<\/span>/);
});

test('the text around a variable survives it, before and after, twice over', () => {
  // A single `${…}` filling the whole string leaves the parts list empty on both
  // sides, which is the case where re-weaving the text and the marks cannot go
  // wrong. A prefix and a suffix is where it can.
  const source = '{"cmd": "run ${A} then ${B} done"}';
  const html = highlightJson(source);
  assert.equal(asText(html), source);
  assert.match(
    html,
    /<span class="j-s">"run <span class="j-v">\$\{A\}<\/span> then <span class="j-v">\$\{B\}<\/span> done"<\/span>/,
  );
});

test('a variable in a key is still a key', () => {
  const html = highlightJson('{"${field}": true}');
  assert.match(html, /<span class="j-k">"\$\{field\}"<\/span>/);
  assert.doesNotMatch(html, /class="j-v"/);
});

test('an empty or whitespace block is not a crash', () => {
  assert.equal(highlightJson(''), '');
  assert.equal(highlightJson('   \n '), '   \n ');
  assert.equal(highlightJson(undefined), '');
});

test('the marker matches the block the page actually has', () => {
  const html = '<pre><code class="json">{"a": 1}</code></pre>';
  const match = PLAN_BLOCK.exec(html);
  assert.equal(match?.[1], '{"a": 1}');
  // Any other code block is left alone: the install snippets stay plain.
  assert.equal(PLAN_BLOCK.exec('<pre><code>npm ci</code></pre>'), null);
});
