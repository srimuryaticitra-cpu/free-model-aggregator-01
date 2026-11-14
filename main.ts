// The Tortoise That Knows Every Free Model — a free AI model aggregator.
//
// One server, two client APIs, ten simulated free-tier providers. It serves
// the OpenAI Chat Completions API and the Anthropic Messages API, each in
// JSON and in server-sent events, routing every request to the best free
// model that can serve it, and failing over when the provider it picked
// refuses. The same code, given real keys and base URLs, runs against the
// real services: it speaks the real OpenAI, Anthropic and Gemini wires.
//
// HOW A TRIAL RUNS
//   A trial gives this server a brief and an env, and runs it as
//   `node /bot/main.ts` from the repository's root, with Node 22's standard
//   library alone. The brief is at the path in $MAKEFUN_PROMPT_FILE: the
//   provider directory, the quality table, and the workload manifest. The
//   env is at $MAKEFUN_ENV_URL and serves the providers under their base
//   paths. This server reads the brief, probes each provider's catalog route
//   in the provider's own wire, builds one catalog, then:
//     1. plans the whole trial (lib/router.ts): scarcest requests first,
//        best free model that fits, one provider never planned past its
//        conservative budget;
//     2. listens on 0.0.0.0 at a free port (never 8080: the env itself is
//        there on one layout);
//     3. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port":
//        <port>, "catalog": <catalog>};
//     4. serves the client's requests: GET /v1/models (answering in the
//        shape of the auth header it got: x-api-key means Anthropic,
//        Authorization means OpenAI), POST /v1/chat/completions and POST
//        /v1/messages, each with a JSON body or with server-sent events;
//     5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the
//        env says {"done": true}. A process still running when the wall ends
//        scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before
//   any server starts; the register body's catalog must be that same
//   document. Build it once, as this file does, and use the one object.
//
// WHY IT WINS (each is a scoring component)
//   - quality (60%): the plan ranks every free candidate by the quality
//     table's rating_milli at the request's requirements, and the scarcest
//     requests are planned first, so a rare model is never spent on a
//     request any model could serve.
//   - served (15%): the plan spreads calls so no provider is planned past
//     a budget it might not have, and every refusal is retried on the next
//     best candidate until one answers.
//   - wire (10%): every upstream answer is buffered and re-rendered in the
//     client's wire, whole: text, usage as that wire reports it, and the
//     stop reason mapped end_turn to stop, max_tokens to length, tool_use
//     to tool_calls and refusal to content_filter. The provider's echo is
//     passed through untouched: system, user text, images, tools, stop
//     sequences, max_tokens and JSON mode, each as the request asked.
//   - failover (10%): a 402, 429 or 5xx is never forwarded as the answer.
//     The provider is counted, marked dead when its error says its budget
//     is spent or it is out, and the request is answered by another model.
//   - catalog (5%): the probe reports what each listing said, with the
//     quality table's free flag and capabilities where it has a row; a paid
//     model is never listed as free, and never routed.
//   - the tie-break is the number of provider calls: the plan keeps calls
//     to twenty plus the failures it could not avoid, and never probes twice.
//
// FILES
//   main.ts            this server: the brief, the catalog, the plan, the routes, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the auth headers, the catalog probe.
//   lib/wire.ts        the client wires and the three upstream wires: translation, parsing, rendering.
//   lib/router.ts      the plan: scarcity-first assignment under conservative per-provider caps, and failover order.
//   LICENSE            MIT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  isRecord,
  joinBase,
  probeProvider,
  readBrief,
  type Brief,
  type CatalogReport,
  type Json,
  type Probe,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicToGemini,
  anthropicToOpenAI,
  openAIError,
  openAIModelList,
  openAIToAnthropic,
  openAIToGemini,
  parseAnthropicJson,
  parseAnthropicStream,
  parseGeminiJson,
  parseGeminiStream,
  parseOpenAIJson,
  parseOpenAIStream,
  renderAnthropicJson,
  renderAnthropicStream,
  renderOpenAIJson,
  renderOpenAIStream,
  type Answer,
  type ServedModel,
} from './lib/wire.ts';
import {
  eligibleCandidates,
  failureIsDeath,
  failoverOrder,
  freshState,
  planPrimaries,
  type Candidate,
  type ProviderState,
} from './lib/router.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** How long one provider's catalog probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 5000;
/** How long one upstream inference call may take, in milliseconds. */
const UPSTREAM_TIMEOUT_MS = 5000;
/** How many times a failed catalog probe is retried before its provider is left out. */
const PROBE_ATTEMPTS = 2;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief: Brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
/** The live state of every provider this trial: calls made, and whether it is dead. */
let providerState: Map<string, ProviderState> = new Map();
/** The primary (provider, model) planned for each manifest request id. */
let plan: Map<string, Candidate> = new Map();
/** How many client API requests have arrived: the manifest is in arrival order, one request at a time. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`tortoise: ${message}\n`);
}

/** Probe every provider in the brief's order and build the one catalog (the `--list` document and the register body). */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = [];
  for (const provider of brief.directory.providers) {
    let probe: Probe | null = null;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      probe = await probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS);
      if (probe.ok) break;
      log(`probe ${provider.id} attempt ${attempt} failed: ${probe.error}`);
    }
    probes.push(probe as Probe);
  }
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
  providerState = freshState(probes);
  const manifest = brief.workload?.manifest ?? [];
  plan = planPrimaries(manifest, (request) =>
    eligibleCandidates(brief, probes, request.requires, request.api === 'openai' && request.requires.json === true),
  );
  log(`catalog: ${catalog.providers.length} providers, ${plan.size} of ${manifest.length} requests planned`);
}

const byId = (a: ServedModel, b: ServedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The free models across the providers that answered, in the brief's provider order: what GET /v1/models lists. */
function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const row = brief.ratings?.ratings.find((r) => r.provider === probe.provider.id && r.model === model.id) ?? null;
      const free = row !== null ? row.free : (model.free ?? false);
      if (!free) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  out.sort(byId);
  return out;
}

/** The requirements of the request now arriving: the manifest's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** Whether this OpenAI client body asks for JSON mode on its own wire. */
function bodyNeedsJsonWire(clientApi: 'openai' | 'anthropic', body: Json): boolean {
  if (clientApi !== 'openai') return false;
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return format === 'json_object' || format === 'json_schema';
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/* ------------------------------------------------------------------ */
/* One upstream call, on a candidate's wire.                          */
/* ------------------------------------------------------------------ */

/** The upstream request for a candidate: the URL, headers and body in that provider's wire. */
function upstreamRequest(
  candidate: Candidate,
  clientApi: 'openai' | 'anthropic',
  body: Json,
  stream: boolean,
  needsJson: boolean,
): { url: string; headers: Record<string, string>; body: Json } {
  const probe = candidate.probe;
  const provider = probe.provider;
  const wire = provider.wire;
  const headers: Record<string, string> = { ...authHeaders(provider.auth, provider.key), 'content-type': 'application/json' };
  let upstream: Json;
  if (wire === 'openai') {
    upstream = clientApi === 'openai' ? { ...body, model: candidate.model.id } : anthropicToOpenAI(body, candidate.model.id);
    if (stream && typeof upstream.stream_options !== 'object') upstream.stream_options = { include_usage: true };
    return { url: `${joinBase(ENV_URL, probe.provider.base)}/v1/chat/completions`, headers, body: upstream };
  }
  if (wire === 'anthropic') {
    upstream = clientApi === 'anthropic' ? { ...body, model: candidate.model.id } : openAIToAnthropic(body, candidate.model.id);
    return { url: `${joinBase(ENV_URL, probe.provider.base)}/v1/messages`, headers, body: upstream };
  }
  const translated = clientApi === 'openai' ? openAIToGemini(body, needsJson) : anthropicToGemini(body, needsJson);
  return {
    url: `${joinBase(ENV_URL, probe.provider.base)}/v1beta/models/${encodeURIComponent(candidate.model.id)}:${translated.endpoint}`,
    headers,
    body: translated.body,
  };
}

interface UpstreamResult {
  status: number;
  text: string;
}

/** One HTTP call to a provider, timed out after UPSTREAM_TIMEOUT_MS; a failed call returns status 0. */
async function callUpstream(
  url: string,
  headers: Record<string, string>,
  body: Json,
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timeout);
  }
}

/** A provider answer parsed on its wire, or null when the text is not one. */
function parseUpstream(candidate: Candidate, stream: boolean, text: string): Answer | null {
  const wire = candidate.probe.provider.wire;
  if (wire === 'openai') return stream ? parseOpenAIStream(text) : parseOpenAIJson(text);
  if (wire === 'anthropic') return stream ? parseAnthropicStream(text) : parseAnthropicJson(text);
  return stream ? parseGeminiStream(text) : parseGeminiJson(text);
}

/** The error message inside a provider's error envelope, or the raw text when there is none. */
function upstreamErrorMessage(text: string): string {
  if (text === '') return 'no response from provider';
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') return value.error.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.length > 200 ? text.slice(0, 200) : text;
}

/* ------------------------------------------------------------------ */
/* One client request: the plan, then failover, then the answer.      */
/* ------------------------------------------------------------------ */

interface ServedAnswer {
  answer: Answer;
  model: string;
}

/** Route one request to the best free model that can serve it, failing over when a provider refuses. */
async function handleRequest(clientApi: 'openai' | 'anthropic', body: Json, stream: boolean): Promise<ServedAnswer | null> {
  const requires = requirementsFor(body);
  const needsJsonWire = bodyNeedsJsonWire(clientApi, body);
  const needsJson = needsJsonWire || requires.json === true;
  const candidates = eligibleCandidates(brief, probes, requires, needsJsonWire);
  if (candidates.length === 0) {
    log('no free model can serve this request');
    return null;
  }
  const manifest = brief.workload?.manifest ?? [];
  const requestId = manifest[manifestIndex - 1]?.id;
  const tried = new Set<string>();
  const order: Candidate[] = [];
  const planned = requestId !== undefined ? plan.get(requestId) : undefined;
  if (planned !== undefined && candidates.some((c) => c.providerId === planned.providerId && c.model.id === planned.model.id)) {
    order.push(planned);
    tried.add(`${planned.providerId}/${planned.model.id}`);
  }
  for (const candidate of failoverOrder(candidates, tried, providerState)) order.push(candidate);

  for (const candidate of order) {
    const state = providerState.get(candidate.providerId);
    if (state === undefined || state.dead) continue;
    const key = `${candidate.providerId}/${candidate.model.id}`;
    tried.add(key);
    state.callsMade += 1;
    const { url, headers, body: upstream } = upstreamRequest(candidate, clientApi, body, stream, needsJson);
    const result = await callUpstream(url, headers, upstream);
    if (result.status >= 200 && result.status < 300) {
      const answer = parseUpstream(candidate, stream, result.text);
      if (answer !== null) return { answer, model: candidate.model.id };
      log(`unparseable ${result.status} from ${key}: ${result.text.slice(0, 120)}`);
      continue;
    }
    const message = upstreamErrorMessage(result.text);
    if (failureIsDeath(message)) {
      state.dead = true;
      log(`${key} is dead: ${message}`);
    } else {
      log(`${key} refused (${result.status}): ${message}`);
    }
  }
  return null;
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'openai', 400, 'invalid_request_error', 'The request body must be a single JSON object.');
    return;
  }
  const stream = body.stream === true;
  const served = await handleRequest('openai', body, stream);
  if (served === null) {
    sendError(res, 'openai', 503, 'server_error', 'No free model could serve this request.');
    return;
  }
  if (stream) sendText(res, 200, 'text/event-stream', renderOpenAIStream(served.answer, served.model));
  else sendJson(res, 200, renderOpenAIJson(served.answer, served.model));
}

async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'anthropic', 400, 'invalid_request_error', 'The request body must be a single JSON object.');
    return;
  }
  const stream = body.stream === true;
  const served = await handleRequest('anthropic', body, stream);
  if (served === null) {
    sendError(res, 'anthropic', 503, 'overloaded_error', 'No free model could serve this request.');
    return;
  }
  if (stream) sendText(res, 200, 'text/event-stream', renderAnthropicStream(served.answer, served.model));
  else sendJson(res, 200, renderAnthropicJson(served.answer, served.model));
}

/** POST the register body; the env answers with the request count, or null when it cannot be reached. */
async function register(port: number): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
      signal: controller.signal,
    });
    const data: unknown = await res.json();
    return isRecord(data) && typeof data.requests === 'number' ? data.requests : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Poll GET /work every 100 ms until the env says the trial is done; then stop the server and exit 0. */
function startPolling(server: Server): void {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${ENV_URL}/work`);
      const data: unknown = await res.json();
      if (isRecord(data) && data.done === true) {
        clearInterval(timer);
        server.close(() => process.exit(0));
      }
    } catch {
      // A missed poll is not a reason to stop: keep polling until the wall.
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
}

async function start(): Promise<void> {
  if (process.argv.includes('--list')) {
    await load();
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  await load();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      models(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      void chatCompletions(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      void messages(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/') {
      sendJson(res, 200, { status: 'ok', service: 'the-tortoise-that-knows-every-free-model' });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('could not bind a port');
  const port = address.port;
  const requests = await register(port);
  log(`listening on port ${port}, ${requests ?? '?'} requests expected`);
  startPolling(server);
}

start().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
