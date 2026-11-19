/**
 * Subtitles for a recording.
 *
 * A step may carry a `caption`, and that single string does two jobs:
 *
 *   - the humanizer draws it in the page for the step's whole duration, so the
 *     recording explains itself when it is played anywhere, including a player
 *     that ignores sidecar tracks;
 *   - the same text is written next to the recording as a WebVTT file, which is
 *     what a `<video><track></video>`, a docs site or YouTube needs to offer
 *     captions as something other than baked-in pixels (searchable, adjustable,
 *     translatable later).
 *
 * A narrated step splits the two on purpose: `say` is the spoken line, so the
 * `.vtt` transcribes the *speech* (which is what makes the caption usable with
 * the sound off) while the pill keeps the short `caption`. A step with no `say`
 * is unaffected — there the two are the same string, as before.
 *
 * Both are derived from the run's own timeline rather than from wall clock in
 * two places: a cue's start and end *are* the step's start and end, so a
 * subtitle cannot describe a frame other than the one it plays over.
 *
 * The timestamps are relative to the recording, which is not the same clock as
 * the run: a second tab is recorded from its own zero point, so the same
 * subtraction the review sheet's chapters use applies here. A caption that tests
 * fine in the player but seeks two seconds early in the file is the failure this
 * module exists to avoid.
 */
import { narrationText } from './narration.mjs';

/** A cue shorter than this is a flash, not a subtitle: nothing to read. */
export const MIN_CUE_MS = 1_200;

/** A cue text with no length limit is a paragraph over a screen of app. */
export const MAX_CAPTION_CHARS = 160;

/**
 * `HH:MM:SS.mmm`, which is the only timestamp shape every VTT consumer accepts
 * (the short `MM:SS.mmm` form is legal but not universally parsed).
 */
export function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const fraction = total % 1_000;
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(fraction, 3)}`;
}

/**
 * The file a recording's captions belong in: `video/01-main.webm` →
 * `video/01-main.vtt`. Browsers find a sidecar only when it is asked for, so the
 * name is a convention here, and the review sheet links it explicitly.
 */
export function vttFor(webmFile) {
  return String(webmFile).replace(/\.[^./\\]+$/, '') + '.vtt';
}

/**
 * Cue text as VTT expects it: one line, entities escaped (a cue body is parsed as
 * a small HTML dialect, so `<` would otherwise open a tag), and no `-->` (which
 * would end the cue early). Whitespace is collapsed because a cue is a line, not
 * a block — wrapping is the player's job.
 */
function cueText(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/-->/g, '→')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The cues for one recording, in playback order.
 *
 * Consecutive steps that carry the same caption are one cue: a plan that says the
 * same thing twice is a subtitle that should not blink, and a video player shows
 * a one-frame gap between two cues as exactly that.
 *
 * A cue stops where its step stops — at the *next step*, whether or not that step
 * has a caption. The overlay draws a caption for its own step only, so a `.vtt`
 * that ran on into the following screen would disagree with the picture it is
 * played against.
 *
 * @param {any} timeline The `.timeline.json` object (or the same shape in memory).
 * @param {{file?: string, page?: number, recordingStartMs?: number}} video
 * @param {{minMs?: number}} [options]
 * @returns {Array<{startMs: number, endMs: number, text: string, spoken: string|null}>}
 *   `text` is the escaped cue body; `spoken` is the line itself, which is what
 *   narration was synthesized from and what the audio is matched against.
 */
export function cuesForRecording(timeline, video, { minMs = MIN_CUE_MS } = {}) {
  // The recording's own zero. `.timeline.json` computes it (`toJSON`), so a
  // caller holding the raw video file list can pass that and still get the right
  // times — which is what the writer does, and the bug this lookup prevents is a
  // second tab whose cues land seconds into a two-second file.
  const fromTimeline = (timeline?.videos ?? []).find((entry) => entry.file && entry.file === video?.file);
  const offset = Number(video?.recordingStartMs ?? fromTimeline?.recordingStartMs) || 0;
  const page = video?.page ?? 1;
  const steps = (timeline?.steps ?? []).filter((step) => (step.page ?? 1) === page && !step.skipped);
  const toRecording = (ms) => Math.max(0, Math.round((Number(ms) || 0) - offset));

  const cues = [];
  steps.forEach((step, index) => {
    // `spoken` is the unescaped, normalized line — the one narration was
    // synthesized from. `text` is what goes in the `.vtt`, so a caption with an
    // `&` in it is still a valid WebVTT cue.
    const spoken = narrationText(step);
    const text = cueText(spoken ?? (typeof step.caption === 'string' ? step.caption : ''));
    if (!text) return;
    const startMs = toRecording(step.startMs);
    const endMs = Math.max(startMs, toRecording(step.endMs ?? step.startMs));
    // The last step of a recording has no boundary to respect.
    const nextStep = steps[index + 1];
    const ceilingMs = nextStep ? Math.max(startMs, toRecording(nextStep.startMs)) : Number.POSITIVE_INFINITY;

    const previous = cues.at(-1);
    if (previous && previous.text === text) {
      previous.endMs = Math.max(previous.endMs, endMs);
      previous.ceilingMs = ceilingMs;
      return;
    }
    cues.push({ startMs, endMs, ceilingMs, text, spoken: spoken ?? null });
  });

  // A step can be over in 300 ms — a click that swaps a screen — and a subtitle
  // that short is unreadable at normal speed. Lengthen it as far as its own step
  // allows, so the file and the picture still end together.
  return cues
    .map(({ startMs, endMs, ceilingMs, text, spoken }) => ({
      startMs,
      endMs: Math.max(endMs, Math.min(startMs + (minMs ?? 0), ceilingMs)),
      text,
      spoken,
    }))
    .filter((cue) => cue.endMs > cue.startMs);
}

/**
 * A WebVTT document for those cues.
 *
 * The NOTE names the run: a `.vtt` next to a `.webm` is copied around on its own
 * (into a site, a video host, a bug report), and by then the file name is the
 * only thing left that says where it came from.
 */
export function buildVtt(cues, { note = null } = {}) {
  const blocks = ['WEBVTT'];
  if (note) blocks.push(`NOTE\n${String(note).replace(/\r?\n/g, ' ')}`);
  for (const cue of cues) {
    blocks.push(`${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`);
  }
  return blocks.join('\n\n') + '\n';
}
