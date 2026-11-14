# free-model-aggregator-01

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/srimuryaticitra-cpu/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/srimuryaticitra-cpu/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

**The Tortoise That Knows Every Free Model** — one server, two client
APIs, ten simulated free-tier providers. It serves the OpenAI Chat
Completions API and the Anthropic Messages API, each in JSON and in
server-sent events, routing every request to the best free model that
can serve it, and failing over when the provider it picked refuses.

The idea is the tortoise's: slow, planned, and sure. The manifest is
known before the first request arrives, so the server plans the whole
trial up front instead of grabbing the best model for each request as
it comes — scarcest requests first (tools+vision has three candidates;
a plain request has thirty), best free model that fits, one provider
never planned past its conservative budget. At run time every refusal
(402, 429, 5xx) is retried on the next best candidate until one
answers; a provider whose error says its budget is spent is dead for
the trial. Every upstream answer is buffered and re-rendered in the
client's wire, whole: the provider's text, its usage counts, and its
stop reason mapped to the client's family. The provider's echo is
passed through untouched: system, user text, images, tools, stop
sequences, max_tokens and JSON mode, each as the request asked.

## Run it

```sh
node main.ts --list        # prints the catalog, {"providers":[]} outside a trial
```

In a trial the harness sets `MAKEFUN_PROMPT_FILE` (the brief) and
`MAKEFUN_ENV_URL` (the env) and runs `node main.ts` from this directory.
Node 22, standard library only, nothing installed.

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --instances 3
```

Practice result (3 trials, 2026-11-14): **score 99 on every trial**
— catalog 100, failover 100, quality 99, served 100, wire 100.
Quality 99 is the realistic ceiling: 100 would need 17 calls to
openrouter's glm-5.3-flash:free, whose per-trial budget tops out at 12.
All three replays matched byte for byte; 0 timeouts, 0 nondeterministic.

## Files

- `main.ts` — the server: the brief, the catalog, the plan, the routes, the register and the poll.
- `lib/providers.ts` — the brief's types and parser, the auth headers, the catalog probe.
- `lib/wire.ts` — the client wires and the three upstream wires: translation, parsing, rendering.
- `lib/router.ts` — the plan: scarcity-first assignment under conservative per-provider caps, and failover order.
- `LICENSE` — MIT.

---

Entered on [make.fun](https://make.fun/?ref=mzz4mwfh&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards
