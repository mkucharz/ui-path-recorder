/**
 * The run's clock.
 *
 * A figure is reviewable by looking at it; a video is not. It needs a spine:
 * where each step starts, what it did, and which moment a figure was taken, so
 * a reviewer can jump to `#t=12.4` instead of scrubbing a minute of video and
 * hoping to recognise the screen.
 *
 * Two clocks are recorded per step on purpose:
 *
 *   plannedMs      the delays the runner chose — seeded, so the same seed and
 *                  the same plan always produce the same numbers. This is the
 *                  reproducible half, and the one a test can assert.
 *   startMs/endMs  wall clock against the run's start. This is what a video
 *                  player seeks by, and it never repeats exactly.
 *
 * A step is closed by the next one starting, so the runner needs no `finally`
 * around every action: `close()` at the end of the run (or in the failure path)
 * finishes the last one. A run that dies late still produced a video worth
 * watching, which is why this is written on failure too — same reason
 * `.vars.json` is.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The first action key of a step — what the step *is*, for a chapter label. */
export function actionOf(step) {
  const actions = [
    'goto',
    'fill',
    'type',
    'press',
    'click',
    'clickIfPresent',
    'clickNewPage',
    'pause',
    'hold',
    'setVar',
    'waitFor',
    'waitHidden',
    'mask',
    'expect',
    'shot',
  ];
  return actions.find((key) => step[key] !== undefined) ?? 'none';
}

/**
 * @param {object} opts
 * @param {any} opts.plan
 * @param {string} opts.planPath
 * @param {string} opts.seed
 * @param {number} opts.speed
 * @param {boolean} opts.humanized
 * @param {{width:number,height:number}} opts.viewport
 * @param {{width:number,height:number}} [opts.videoSize] the recorded canvas: the
 *   viewport by default, or a larger canvas of the same shape for a 1080p upload.
 * @param {number} [opts.fps]
 * @param {number} [opts.startedAt] `Date.now()` of the run's start.
 * @param {number} [opts.videoStartedAt] `Date.now()` the first page — and so the
 *   first recording — was opened.
 * @param {(page: number) => number|null} [opts.pageStartedAt] When a tab's own
 *   recording began. Each page is recorded from its own zero point, so a chapter
 *   in the second tab seeks by that tab's clock, not the first one's.
 * @param {() => number} [opts.planned] Drains the humanizer's scheduled delay.
 */
export function createTimeline({
  plan,
  planPath,
  seed,
  speed,
  humanized,
  viewport,
  fps = null,
  videoSize = null,
  startedAt = Date.now(),
  videoStartedAt = null,
  pageStartedAt = null,
  planned = () => 0,
}) {
  const steps = [];
  let open = null;
  let videos = [];
  /**
   * Video time starts when the recorder does, which is before the plan's first
   * step. A chapter is a seek into the file, so it adds that head start —
   * otherwise every chapter lands early by however long the browser took.
   */
  const videoOffsetMs = videoStartedAt ? Math.max(0, startedAt - videoStartedAt) : 0;

  /**
   * Where a tab's recording began, relative to the run's start (usually
   * negative for the first tab). A `clickNewPage` flow has one recording per
   * tab, and the second one begins when the tab opens — so subtracting this is
   * what stops a chapter for tab two from seeking a second and a half into a
   * file that is only two seconds long.
   */
  const recordingStart = (page) => {
    const at = pageStartedAt?.(page);
    if (at) return at - startedAt;
    return page === 1 ? -videoOffsetMs : 0;
  };

  const at = () => Date.now() - startedAt;

  function close(record) {
    if (!record || record.endMs !== null) return;
    record.endMs = at();
    if (record.plannedMs === null) record.plannedMs = planned();
  }

  return {
    /**
     * Open a step. Closes the previous one, so the runner does not need a
     * `finally` around a body full of `continue`s.
     */
    begin({ index, name = null, action, caption = null }) {
      close(open);
      const record = {
        index,
        name,
        action,
        caption,
        startMs: at(),
        endMs: null,
        plannedMs: null,
        skipped: false,
        failed: false,
        shot: null,
        page: 1,
      };
      open = record;
      steps.push(record);
      return {
        record,
        /** A figure was written here; the pointer must have been hidden for it. */
        shot(id) {
          record.shot = { id, cursorHidden: humanized };
        },
        page(number) {
          record.page = number;
        },
        skip(reason) {
          record.skipped = true;
          record.skipReason = reason;
          close(record);
        },
        /** The step that failed the run — the video's last interesting frame. */
        failed() {
          record.failed = true;
          close(record);
        },
      };
    },
    close() {
      close(open);
      open = null;
    },
    setVideos(files) {
      videos = files;
    },
    /** Chapters for the review sheet: one per named step, in plan order. */
    chapters() {
      return steps
        .filter((step) => !step.skipped && step.name)
        .map((step) => ({
          name: step.name,
          atMs: Math.max(0, step.startMs - recordingStart(step.page)),
          shot: step.shot?.id ?? null,
          action: step.action,
          page: step.page,
        }));
    },
    toJSON() {
      return {
        tutorial: plan?.tutorial ?? plan?.instance ?? null,
        plan: planPath ? path.basename(planPath) : null,
        humanized: Boolean(humanized),
        seed,
        speed,
        viewport: viewport ?? null,
        fps,
        videoSize: videoSize ?? null,
        startedAt: new Date(startedAt).toISOString(),
        videoOffsetMs,
        durationMs: steps.reduce((max, step) => Math.max(max, step.endMs ?? step.startMs), 0),
        videos: videos.map((video) => ({
          ...video,
          // `|| 0` because Math.round(-0.4) is -0, which serialises as 0 and
          // would make the in-memory object differ from the file it wrote.
          recordingStartMs: Math.round(recordingStart(video.page ?? 1)) || 0,
        })),
        steps,
      };
    },
    async write(dir) {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, '.timeline.json');
      await writeFile(file, JSON.stringify(this.toJSON(), null, 2) + '\n');
      return file;
    },
  };
}
