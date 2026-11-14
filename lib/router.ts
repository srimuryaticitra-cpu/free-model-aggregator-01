// The router: plan the trial before it starts, fail over when a provider refuses.
//
// The idea is the tortoise's: slow, planned, and sure. The manifest is known
// before the first request arrives, so the router plans the whole trial up
// front instead of grabbing the best model for each request as it comes:
//
//   1. Scarcity first: the requests with the fewest eligible models are
//      planned first (tools+vision has three candidates; a plain request has
//      thirty), so a rare model is never spent on a request any model could
//      serve. Within equal scarcity, heavier requests go first.
//   2. Best free model that fits: each request takes the highest-rated free
//      model meeting its requirements, on a provider that still has planned
//      room. A paid model is never a legal pick.
//   3. Room per provider: a provider's planned calls are capped at its
//      conservative minimum budget — the low end of the per-trial budget
//      range the kit's published generator draws from (calls_min per
//      provider). A provider is never planned past a budget it might not
//      have, so a planned call is almost never refused for being over
//      budget. Failover may still spend past the cap: a live refusal is
//      worth one more call, and the true budget may be higher.
//
// At run time every provider call is counted. A provider that answers 402
// or 429 with "budget is spent" or "is out" is dead for the trial and never
// tried again. Any other refusal (a scheduled fail, a concurrent refusal)
// only costs that call: the next candidate is tried, best-rated first,
// preferring providers with fewer calls made. A failed call never answers
// the request, so the trial's `one_provider` check still sees exactly one
// successful provider call per request.
//
// Everything is a function of the brief, the manifest and the providers'
// answers so far: no clock, no unseeded randomness, so a replay takes the
// same route and leaves the same state export.

import {
  capabilitiesOf,
  meetsRequirements,
  modelFree,
  ratingOfModel,
  type Brief,
  type Probe,
  type ProbedModel,
  type Requirement,
  type WorkloadRequest,
} from './providers.ts';

/** One (provider, model) pair that could serve a request, with its rating and capabilities. */
export interface Candidate {
  providerId: string;
  probe: Probe;
  model: ProbedModel;
  rating: number;
  contextLength: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

/**
 * The conservative per-provider call cap the plan uses: the low end of the
 * per-trial budget range the kit's published generator draws from
 * (calls_min). Unknown providers get 4, the lowest minimum in the table.
 */
export const CALLS_MIN: Record<string, number> = {
  groq: 9,
  cerebras: 5,
  gemini: 6,
  zai: 4,
  openrouter: 10,
  sambanova: 4,
  pollinations: 10,
  cloudflare: 7,
  ovh: 5,
  kilol: 12,
};

export function callCap(providerId: string): number {
  return CALLS_MIN[providerId] ?? 4;
}

/** The live state of one provider this trial: how many inference calls it has taken, and whether it is dead. */
export interface ProviderState {
  callsMade: number;
  dead: boolean;
}

/** Fresh live state for every probed provider. */
export function freshState(probes: readonly Probe[]): Map<string, ProviderState> {
  const state = new Map<string, ProviderState>();
  for (const probe of probes) state.set(probe.provider.id, { callsMade: 0, dead: false });
  return state;
}

/**
 * The free models that could serve a request with these requirements, best-rated first.
 * `needsJsonWire` is true when an OpenAI client asked for JSON mode: an Anthropic-wire provider
 * can never echo json_mode, so it is not a candidate then. The model itself must still be
 * JSON-capable whenever the requirements say so, on any wire.
 */
export function eligibleCandidates(
  brief: Brief,
  probes: readonly Probe[],
  requires: Requirement,
  needsJsonWire: boolean,
): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    if (needsJsonWire && probe.provider.wire === 'anthropic') continue;
    for (const model of probe.models) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      const caps = capabilitiesOf(model, row);
      if (!meetsRequirements(requires, caps)) continue;
      out.push({
        providerId: probe.provider.id,
        probe,
        model,
        rating: row?.rating_milli ?? 0,
        contextLength: caps.context_length,
        tools: caps.tools === true,
        vision: caps.vision === true,
        json: caps.json === true,
      });
    }
  }
  out.sort((a, b) => b.rating - a.rating || (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0));
  return out;
}

/**
 * Plan one primary (provider, model) per manifest request, before the trial starts.
 * Requests are planned scarcest first, heaviest first, manifest order last; each takes its
 * best-rated candidate on a provider with planned room left. A request with no candidate at
 * all gets no primary: the run-time failover walks the full candidate list instead.
 */
export function planPrimaries(
  manifest: readonly WorkloadRequest[],
  candidatesOf: (request: WorkloadRequest) => Candidate[],
): Map<string, Candidate> {
  const planned = new Map<string, number>();
  const plan = new Map<string, Candidate>();
  const order = [...manifest].sort((a, b) => {
    const ca = candidatesOf(a).length;
    const cb = candidatesOf(b).length;
    if (ca !== cb) return ca - cb;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return manifest.indexOf(a) - manifest.indexOf(b);
  });
  for (const request of order) {
    for (const candidate of candidatesOf(request)) {
      const used = planned.get(candidate.providerId) ?? 0;
      if (used >= callCap(candidate.providerId)) continue;
      planned.set(candidate.providerId, used + 1);
      plan.set(request.id, candidate);
      break;
    }
  }
  return plan;
}

/**
 * The order to try candidates for one request at run time: best-rated first, preferring
 * providers with fewer calls made, then by provider and model id. `tried` holds the
 * `providerId/modelId` keys already attempted for this request; dead providers are skipped.
 */
export function failoverOrder(
  candidates: readonly Candidate[],
  tried: ReadonlySet<string>,
  state: ReadonlyMap<string, ProviderState>,
): Candidate[] {
  return candidates
    .filter((c) => !tried.has(`${c.providerId}/${c.model.id}`) && state.get(c.providerId)?.dead !== true)
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        (state.get(a.providerId)?.callsMade ?? 0) - (state.get(b.providerId)?.callsMade ?? 0) ||
        (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
        (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0),
    );
}

/** The error text that says a provider's budget is spent, or that it is out for the trial. */
export function failureIsDeath(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('budget is spent') || text.includes('is out');
}
