interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * RxNorm MCP — wraps the NLM RxNav REST API (free, no auth)
 *
 * RxNorm is the standard drug nomenclature system that normalizes drug names
 * across brands, generics, and ingredients.
 *
 * Tools:
 * - rxnorm_search: search for drugs by name (brand or generic)
 * - rxnorm_get_properties: get properties for a drug by RxCUI
 * - rxnorm_related: get related concepts (brand <-> generic <-> ingredient <-> dose forms)
 * - rxnorm_ndc: get NDC codes for a drug
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'RxNorm');
}

const BASE_URL = 'https://rxnav.nlm.nih.gov/REST';

const tools: McpToolExport['tools'] = [
  {
    name: 'rxnorm_search',
    description:
      'Look up a medication\'s RxCUI and MAP A BRAND DRUG TO ITS GENERIC INGREDIENT (and vice versa) — e.g. Eliquis -> apixaban, Lipitor -> atorvastatin. Search by brand or generic name; returns RxCUI IDs, names, synonyms, and term types (BN=brand, IN=ingredient, SBD=dose form). The right tool for "what is the RxCUI for X", "what generic ingredient does brand X map to", or "brand vs generic name". Start here to find a drug\'s unique ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Drug name to search for — brand or generic (e.g., "Ozempic", "semaglutide", "metformin")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'rxnorm_get_properties',
    description:
      'Get full medication details by RxCUI ID. Returns name, synonyms, term type, language, and status. Use after rxnorm_search to retrieve complete drug information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID (e.g., "7052" for metformin) OR a drug name (e.g. "aspirin", "Tylenol") — names are resolved to an RxCUI automatically.' },
      },
      required: ['rxcui'],
    },
  },
  {
    name: 'rxnorm_related',
    description:
      'Find related medications by RxCUI — brands, generics, ingredients, and dose forms. Maps between brand and generic alternatives. Use to compare drug options.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID, or a drug name (e.g. "aspirin") — resolved to an RxCUI automatically.' },
        tty: {
          type: 'string',
          description:
            'Optional term type filter: BN (brand name), IN (ingredient), SBD (semantic branded drug), SCD (semantic clinical drug), GPCK (generic pack), BPCK (branded pack); other RxNorm term types such as PIN, MIN, DF and DFG also work. For several, separate them with a comma, a plus or a space — "BN,SBD", "BN+SBD" and "BN SBD" are all accepted and equivalent. Case does not matter. Omit for the default set (IN, BN, SBD, SCD, GPCK, BPCK).',
        },
      },
      required: ['rxcui'],
    },
  },
  {
    name: 'rxnorm_ndc',
    description:
      'Get the NDC (National Drug Code) identifiers for a drug — the 11-digit US pharmacy codes used for billing, dispensing and inventory. Takes an RxCUI or a plain drug name ("amoxicillin", "Lipitor"). NDCs attach to marketed products rather than to an ingredient, so an ingredient or brand name is expanded to its products automatically and the response says it did so; a concept with nothing currently marketed reports its historical NDC count instead of an unexplained empty list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID, or a drug name — resolved to an RxCUI automatically. A bare ingredient ("amoxicillin") works: it is expanded to its marketed products. A full dose phrase ("lisinopril 10 mg oral tablet") returns that one product\'s complete list.' },
      },
      required: ['rxcui'],
    },
  },
];

// ── Response types ──────────────────────────────────────────────────

interface DrugConcept {
  rxcui: string;
  name: string;
  synonym: string;
  tty: string;
  language: string;
  suppress: string;
  umlscui: string;
}

interface ConceptGroup {
  tty: string;
  conceptProperties?: DrugConcept[];
}

interface DrugGroup {
  name: string;
  conceptGroup?: ConceptGroup[];
}

interface PropertiesConcept {
  rxcui: string;
  name: string;
  synonym: string;
  tty: string;
  language: string;
  suppress: string;
  umlscui: string;
}

interface RelatedGroup {
  conceptGroup?: ConceptGroup[];
}

interface InteractionConcept {
  minConceptItem: {
    rxcui: string;
    name: string;
    tty: string;
  };
  sourceConceptItem: {
    id: string;
    name: string;
    url: string;
  };
}

interface InteractionPair {
  interactionConcept: InteractionConcept[];
  severity: string;
  description: string;
}

interface InteractionTypeGroup {
  sourceDisclaimer: string;
  sourceName: string;
  fullInteractionType?: {
    comment: string;
    minConcept: { rxcui: string; name: string; tty: string }[];
    interactionPair: InteractionPair[];
  }[];
}

// ── Tool implementations ────────────────────────────────────────────

/**
 * RxNav's /drugs endpoint returns ONLY marketed products — SBD and SCD. It never
 * returns IN (ingredient) or BN (brand name), for any drug. This tool's whole
 * stated job is mapping a brand to its generic ingredient and back, and callers
 * downstream pick the ingredient by term type, so "the RxCUI for atorvastatin"
 * came back as 262095, "atorvastatin 80 MG Oral Tablet [Lipitor]" — a specific
 * branded 80mg tablet offered as the answer to a question about the ingredient.
 * The ingredient is 83367.
 *
 * The exact-name endpoint does resolve the ingredient, and one `related` hop off
 * it yields both IN and BN from either direction ("Lipitor" and "atorvastatin"
 * both land on the same pair). So enrich with that and put IN/BN first.
 */
async function ingredientAndBrand(name: string) {
  const idRes = await pwFetch(`${BASE_URL}/rxcui.json?name=${encodeURIComponent(name)}`);
  if (!idRes.ok) return [];
  const idData = (await idRes.json()) as { idGroup?: { rxnormId?: string[] } };
  const seed = idData.idGroup?.rxnormId?.[0];
  if (!seed) return [];

  const relRes = await pwFetch(`${BASE_URL}/rxcui/${seed}/related.json?tty=IN+BN`);
  if (!relRes.ok) return [];
  const relData = (await relRes.json()) as { relatedGroup?: RelatedGroup };
  return (relData.relatedGroup?.conceptGroup ?? [])
    .filter((g) => g.conceptProperties && g.conceptProperties.length > 0)
    .map((g) => ({
      term_type: g.tty,
      concepts: g.conceptProperties!.map((c) => ({
        rxcui: c.rxcui, name: c.name, synonym: c.synonym || null, tty: c.tty, language: c.language,
      })),
    }))
    // RxNav hands back BN before IN. Callers read the first group as the answer,
    // so "the RxCUI for atorvastatin" would lead with Lipitor. Ingredient first.
    .sort((a, b) => (a.term_type === 'IN' ? -1 : b.term_type === 'IN' ? 1 : 0));
}

async function searchDrugs(name: string) {
  const [res, canonical] = await Promise.all([
    pwFetch(`${BASE_URL}/drugs.json?name=${encodeURIComponent(name)}`),
    ingredientAndBrand(name).catch(() => []),
  ]);
  if (!res.ok) throw await httpError(res, 'RxNorm API error');

  const data = (await res.json()) as { drugGroup: DrugGroup };
  const drugGroup = data.drugGroup;
  const productGroups = (drugGroup?.conceptGroup ?? [])
    .filter((g) => g.conceptProperties && g.conceptProperties.length > 0)
    .map((g) => ({
      term_type: g.tty,
      concepts: g.conceptProperties!.map((c) => ({
        rxcui: c.rxcui,
        name: c.name,
        synonym: c.synonym || null,
        tty: c.tty,
        language: c.language,
      })),
    }));

  // Ingredient and brand lead: a caller asking for "the RxCUI" of a drug name
  // wants the concept that is stable across sources, not one marketed strength.
  const seen = new Set(canonical.map((g) => g.term_type));
  return {
    // drugGroup.name is null whenever RxNav matched on a synonym, which made the
    // echoed name useless; fall back to what was asked.
    name: drugGroup?.name ?? name,
    concept_groups: [...canonical, ...productGroups.filter((g) => !seen.has(g.term_type))],
  };
}

async function getProperties(rxcui: string) {
  const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
  if (!res.ok) throw await httpError(res, 'RxNorm API error');

  const data = (await res.json()) as { properties: PropertiesConcept | null };
  if (!data.properties) throw new Error(`No properties found for RxCUI: ${rxcui}`);

  const p = data.properties;
  return {
    rxcui: p.rxcui,
    name: p.name,
    synonym: p.synonym || null,
    tty: p.tty,
    language: p.language,
    suppress: p.suppress,
  };
}

/**
 * RxNav accepts term types PLUS-separated and nothing else. Measured against the
 * live API on 2026-09-03, rxcui 1243465:
 *   tty=BN+SBD    -> 200, 2 groups     tty=BN,SBD   -> 400
 *   tty=BN%20SBD  -> 200, 2 groups     tty=BN%2BSBD -> 400
 * (space works because a query string decodes it to the same thing as '+'; a
 * PERCENT-ENCODED plus is a literal '+' inside one value and is rejected.)
 *
 * Callers do not know that, and had no reason to: this tool's own description
 * said "Comma-separated for multiple" and its own shipped example passed
 * "BN,SBD" — which 400'd on every call since the tool shipped (feedback #53,
 * fleet #1177). The reporter was right and the documentation was wrong.
 *
 * So accept what anyone would plausibly type — comma, plus, space, semicolon,
 * in any combination — and normalise to what RxNav takes. Deliberately NOT
 * validated against a hardcoded tty list: RxNorm has ~20 term types and a stale
 * allowlist here would reject a valid one silently, which is worse than the
 * upstream 400 that a genuinely bad value still produces.
 */
function normalizeTty(tty: string): string[] {
  return tty
    .split(/[\s,;+]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

async function getRelated(rxcui: string, tty?: string) {
  const requested = tty?.trim() ? normalizeTty(tty) : ['IN', 'BN', 'SBD', 'SCD', 'GPCK', 'BPCK'];
  // Encode each value, then join with a LITERAL '+' — encodeURIComponent over
  // the whole string turns the separator into %2B, which RxNav reads as part of
  // one value and rejects.
  const ttyEncoded = requested.map((t) => encodeURIComponent(t)).join('+');
  let url = `${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${ttyEncoded}`;

  const res = await pwFetch(url);
  if (!res.ok) {
    // RxNav answers any bad tty with the same opaque "Path or Query Parameter
    // error", which tells a caller nothing about WHICH argument to change.
    if (res.status === 400 && tty?.trim()) {
      throw new Error(
        `user_error: RxNorm rejected the request, and the term-type filter is the likely cause — ` +
          `it parsed as ${JSON.stringify(requested)}. Valid term types include IN (ingredient), ` +
          `PIN, MIN, BN (brand name), SBD (semantic branded drug), SCD (semantic clinical drug), ` +
          `GPCK, BPCK, DF and DFG. Separate several with a comma, plus or space — all three work. ` +
          `Omit tty entirely to get the default set.`,
      );
    }
    throw await httpError(res, 'RxNorm API error');
  }

  const data = (await res.json()) as { relatedGroup: RelatedGroup };
  const groups = data.relatedGroup?.conceptGroup ?? [];

  // RxNav returns a group ENVELOPE per requested tty even when it holds nothing
  // — conceptProperties is null — so `groups.length` is 2 for a concept with no
  // relations at all. Count the concepts, never the containers.
  const related = groups
    .filter((g) => g.conceptProperties && g.conceptProperties.length > 0)
    .map((g) => ({
      term_type: g.tty,
      concepts: g.conceptProperties!.map((c) => ({
        rxcui: c.rxcui,
        name: c.name,
        tty: c.tty,
      })),
    }));

  if (related.length === 0) {
    // TWO DIFFERENT NEGATIVES, and they used to be one. "This identifier is not
    // a drug" and "this drug has no brands" both rendered as related_groups: []
    // with a clean 200, so a caller working from a typo'd or stale RxCUI would
    // conclude the drug has no relations rather than that it does not exist.
    if (!(await conceptExists(rxcui))) {
      return {
        rxcui,
        found: false,
        reason: 'rxcui_not_found',
        hint: `RxCUI ${rxcui} is not a concept in RxNorm — it has no name and no relations of any kind, so this is not "a drug with no related products". Check the identifier, or find it by name with rxnorm_search({name: "..."}).`,
      };
    }
    return {
      rxcui,
      related_groups: [],
      found: false,
      reason: 'no_related_concepts',
      hint: `RxCUI ${rxcui} exists${tty?.trim() ? `, but has no related concepts of term type ${JSON.stringify(normalizeTty(tty).join('+'))}` : ' but has no related concepts in the default term types'}. Try omitting tty, or a broader one such as SCD or IN.`,
    };
  }

  return { rxcui, related_groups: related };
}

async function ndcsFor(rxcui: string): Promise<string[]> {
  const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`);
  if (!res.ok) throw await httpError(res, 'RxNorm API error');
  const data = (await res.json()) as { ndcGroup: { ndcList?: { ndc: string[] } } };
  return data.ndcGroup?.ndcList?.ndc ?? [];
}

async function termType(rxcui: string): Promise<string | null> {
  const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/property.json?propName=TTY`);
  if (!res.ok) return null;
  const data = (await res.json()) as { propConceptGroup?: { propConcept?: { propValue?: string }[] } };
  return data.propConceptGroup?.propConcept?.[0]?.propValue ?? null;
}

// NDCs hang off marketed PRODUCTS, never off an ingredient or a brand name. So
// "What NDC codes are associated with amoxicillin?" resolved correctly to RXCUI
// 723 and then returned nothing, because 723 is the ingredient concept.
const INGREDIENT_TTYS = new Set(['IN', 'MIN', 'PIN', 'BN', 'BPCK', 'SBDC', 'SCDC', 'DF', 'DFG']);
const MAX_PRODUCTS = 25;

async function productConcepts(rxcui: string): Promise<{ rxcui: string; name: string }[]> {
  const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=SCD+SBD`);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    relatedGroup?: { conceptGroup?: { conceptProperties?: { rxcui: string; name: string }[] }[] };
  };
  return (data.relatedGroup?.conceptGroup ?? []).flatMap((g) => g.conceptProperties ?? []);
}

async function historicalNdcCount(rxcui: string): Promise<number> {
  const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/allhistoricalndcs.json`);
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    historicalNdcConcept?: { historicalNdcTime?: { ndcTime?: { ndc?: string[] }[] }[] };
  };
  return (data.historicalNdcConcept?.historicalNdcTime ?? [])
    .flatMap((t) => t.ndcTime ?? []).reduce((n, x) => n + (x.ndc?.length ?? 0), 0);
}

async function getNdcCodes(rxcui: string) {
  const direct = await ndcsFor(rxcui);
  if (direct.length) return { rxcui, ndc_count: direct.length, ndcs: direct, grain: 'product' as const };

  // Nothing directly attached. Walk down to the products before concluding
  // absence — telling the caller to re-phrase with a dose form is asking them to
  // do a lookup we can do ourselves.
  const tty = await termType(rxcui);
  if (tty && INGREDIENT_TTYS.has(tty)) {
    const products = await productConcepts(rxcui);
    const searched = products.slice(0, MAX_PRODUCTS);
    const perProduct = await Promise.all(searched.map(async (p) => ({ p, ndcs: await ndcsFor(p.rxcui).catch(() => []) })));
    const withNdcs = perProduct.filter((x) => x.ndcs.length);
    const ndcs = [...new Set(withNdcs.flatMap((x) => x.ndcs))];
    if (ndcs.length) {
      return {
        rxcui,
        term_type: tty,
        grain: 'expanded_from_ingredient' as const,
        ndc_count: ndcs.length,
        ndcs,
        products_total: products.length,
        products_searched: searched.length,
        ...(products.length > searched.length ? {
          truncated: true,
          note: `NDCs attach to marketed products, not to the ${tty === 'BN' ? 'brand name' : 'ingredient'} concept ${rxcui}. Expanded to its products and read the first ${searched.length} of ${products.length}; ask by a specific dose phrase ("amoxicillin 500 MG Oral Capsule") for one product's complete list.`,
        } : {
          note: `NDCs attach to marketed products, not to the ${tty === 'BN' ? 'brand name' : 'ingredient'} concept ${rxcui}. Expanded to its ${products.length} product concepts.`,
        }),
        products: withNdcs.slice(0, 10).map((x) => ({ rxcui: x.p.rxcui, name: x.p.name, ndc_count: x.ndcs.length })),
      };
    }
  }

  // Still nothing current. Historical NDCs distinguish "never marketed under
  // this concept" from "marketed once, not any more" — an empty list alone
  // cannot say which, and they mean different things to a claims lookup.
  const historical = await historicalNdcCount(rxcui);

  // Same two-negatives problem as getRelated, and here the old hint actively
  // asserted the false half: for a DEAD identifier it told the caller "if this
  // is a dose form, brand family or ingredient class..." — i.e. that the concept
  // exists and is merely the wrong kind. Only reached on the zero path, and only
  // when RxNorm holds no historical NDCs either, so it costs nothing normally.
  if (historical === 0 && !(await conceptExists(rxcui))) {
    return {
      rxcui,
      ...(tty ? { term_type: tty } : {}),
      ndc_count: 0,
      ndcs: [],
      found: false,
      reason: 'rxcui_not_found',
      hint: `RxCUI ${rxcui} is not a concept in RxNorm — it has no name and no NDCs, current or historical. This is not a drug without packaging; the identifier itself does not resolve. Find the drug by name with rxnorm_search({name: "..."}).`,
    };
  }

  return {
    rxcui,
    ...(tty ? { term_type: tty } : {}),
    ndc_count: 0,
    ndcs: [],
    found: false,
    reason: historical > 0 ? 'no_currently_marketed_ndcs' : 'no_ndcs_for_concept',
    ...(historical > 0 ? { historical_ndc_count: historical } : {}),
    hint: historical > 0
      ? `No NDC is currently marketed under RxCUI ${rxcui}, though ${historical} appear in RxNorm's historical record — the product existed and was discontinued or repackaged. Treat this as "not currently marketed", not as an invalid code.`
      : `RxCUI ${rxcui}${tty ? ` (${tty})` : ''} carries no NDCs. NDCs attach to marketed drug products; if this is a dose form, brand family or ingredient class, use rxnorm_related({rxcui, tty: "SCD"}) to reach the products first.`,
  };
}

// Agents frequently pass a drug NAME ("aspirin", "Tylenol") where an rxcui is
// expected, which RxNav 400s. If the value isn't a bare RxCUI (digits), resolve
// it via the name→rxcui endpoint first. That endpoint is EXACT-match only, so a
// dose phrase like "lisinopril 10 mg oral tablets" misses; approximateTerm's
// fuzzy match resolves it to the product-level concept (SCD), which is strictly
// better — the bare-ingredient rxcui a caller might strip down to carries zero
// NDCs, so "helpfully" simplifying the name here would trade a loud error for a
// silent empty result.
/**
 * Does this RxCUI exist at all?
 *
 * resolveRxcui() passes any all-digits string straight through — it assumes a
 * number is an RxCUI rather than checking. That is fine for the happy path and
 * is the reason a DEAD identifier and a REAL concept with nothing to return
 * rendered identically: both produced `related_groups: []` with a clean 200.
 * 1243465 was our own shipped example and does not exist (fleet #1177/#1180).
 *
 * Called ONLY when a result comes back empty, so the common case pays no extra
 * round trip and only the ambiguous case does.
 */
async function conceptExists(rxcui: string): Promise<boolean> {
  try {
    const res = await pwFetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
    if (!res.ok) return false;
    const data = (await res.json()) as { properties?: { name?: string } };
    return Boolean(data.properties?.name);
  } catch {
    // An upstream hiccup must not be reported as "this drug does not exist" —
    // that is a far more confident claim than we can make from a failed probe.
    return true;
  }
}

async function resolveRxcui(input: unknown): Promise<{ rxcui?: string; error?: unknown }> {
  const s = String(input ?? '').trim();
  if (!s) return { error: { error: 'missing_rxcui', message: 'Pass an rxcui (e.g. "161") or a drug name (e.g. "aspirin").' } };
  if (/^\d+$/.test(s)) return { rxcui: s };
  const res = await pwFetch(`${BASE_URL}/rxcui.json?name=${encodeURIComponent(s)}`);
  if (res.ok) {
    const data = (await res.json()) as { idGroup?: { rxnormId?: string[] } };
    const id = data.idGroup?.rxnormId?.[0];
    if (id) return { rxcui: id };
  }
  const approx = await pwFetch(`${BASE_URL}/approximateTerm.json?term=${encodeURIComponent(s)}&maxEntries=1`);
  if (approx.ok) {
    const data = (await approx.json()) as { approximateGroup?: { candidate?: { rxcui?: string }[] } };
    const id = data.approximateGroup?.candidate?.[0]?.rxcui;
    if (id) return { rxcui: id };
  }
  return { error: { error: 'unknown_drug', message: `Could not resolve "${s}" to an RxCUI. Try rxnorm_search({name: "${s}"}) to find the drug, then pass its rxcui.` } };
}

// ── callTool dispatcher ─────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'rxnorm_search':
      return searchDrugs(args.name as string);

    case 'rxnorm_get_properties': {
      const r = await resolveRxcui(args.rxcui);
      return r.error ?? getProperties(r.rxcui as string);
    }

    case 'rxnorm_related': {
      const r = await resolveRxcui(args.rxcui);
      return r.error ?? getRelated(r.rxcui as string, args.tty as string | undefined);
    }

    case 'rxnorm_ndc': {
      const r = await resolveRxcui(args.rxcui);
      return r.error ?? getNdcCodes(r.rxcui as string);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
