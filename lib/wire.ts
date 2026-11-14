// The client wires and the three upstream wires.
//
// The trial's client calls this entry as an OpenAI service (POST
// /v1/chat/completions) or an Anthropic one (POST /v1/messages), with a JSON
// body or with server-sent events. Each provider speaks its own wire —
// openai, anthropic or gemini — so a request is translated into the chosen
// provider's wire, and the provider's answer is translated back into the
// wire the client used.
//
// What the translations must preserve, exactly, is what the env's client
// checks by the provider's echo: the system prompt, the user text, the tool
// names, max_tokens, the stop sequences, the image, and JSON mode. A field
// rewritten or dropped loses the request. Two wire facts matter most:
//
//   - an Anthropic-wire provider can never carry JSON mode (its echo always
//     reports json_mode false), so an OpenAI request that asks for JSON mode
//     is never routed to one; the router enforces that.
//   - a Gemini-wire provider carries JSON mode as
//     generationConfig.responseMimeType "application/json".
//
// The provider's answer is always one text (the ANSWER ECHO) plus usage and
// a stop reason, never a tool call of its own. This file therefore buffers
// an upstream answer — JSON or SSE — into one Answer, then renders it in
// the client's wire. Buffering also keeps the Anthropic stream honest: its
// message_start carries the true input tokens, which only arrive at the end
// of an OpenAI provider's stream.
//
// Everything here is a pure function of its arguments: no clock and no
// randomness, so the same body and the same provider answer give the same
// bytes on a replay. The two model listings use fixed timestamps for the
// same reason: a `created` that moved between runs would be a
// nondeterministic document.

import { isRecord, type Json } from './providers.ts';

/** One model the entry serves, as GET /v1/models lists it. */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

/** One provider answer, reduced to what the client is owed: the text, the usage, the stop family. */
export interface Answer {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The provider's stop reason as it arrived ("stop", "end_turn", "STOP", ...). */
  stop: string;
}

/** A fixed epoch second for every listed model's `created`: nothing in the reply reads the clock. */
const FIXED_OPENAI_CREATED = 1767225600;
/** A fixed instant for every listed model's `created_at`: nothing in the reply reads the clock. */
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

/** GET /v1/models on an OpenAI-shaped request: the models this entry serves, in OpenAI's list shape. */
export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
  };
}

/** GET /v1/models on an Anthropic-shaped request (an x-api-key header): Anthropic's model list shape. */
export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

/** An error in Anthropic's shape (the Messages API's error envelope). */
export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/** An error in OpenAI's shape (Chat Completions). */
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

/** The text of a string or of a block array's text blocks; '' when there is none. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

/** A tool_result block's content as text: its text blocks, or its JSON when it holds something else. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** A tool call's arguments as an object: the provider's JSON string, or {} when it is not one. */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** OpenAI's finish_reason as Anthropic's stop_reason. */
export function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** One SSE frame: `event: <name>` when named, then the JSON data line, then the blank line. */
export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Split a data URL into its media type and base64 payload, or null when it is not one. */
function dataUrlParts(url: string): { media: string; data: string } | null {
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { media: m[1] !== '' ? m[1] : 'image/png', data: m[2] };
}

/** The text of the nearest user message before `at` in an OpenAI message list, for the echo insurance below. */
function nearestUserText(messages: Json[], at: number): string {
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return textOf(m.content);
  }
  return '';
}

/**
 * An Anthropic Messages request as an OpenAI Chat Completions request that names `model`: the system
 * prompt becomes a system message, image blocks become image_url data URLs, tool_use blocks become
 * tool_calls, tool_result blocks become tool messages, tools and tool_choice are rewritten, and the
 * output cap, temperature, top_p, stop sequences and streaming pass through.
 */
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** One Anthropic content block as an OpenAI content part: text or an inline image; null for the rest. */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** One OpenAI content part as an Anthropic content block: text or an inline image; null for the rest. */
function blockOf(part: Json): Json | null {
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
    const url = part.image_url.url;
    const data = dataUrlParts(url);
    if (data !== null) return { type: 'image', source: { type: 'base64', media_type: data.media, data: data.data } };
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/**
 * A Chat Completions request as an Anthropic Messages request that names `model`.
 *
 * The echo insurance: the env's Anthropic parser takes the user text from the LAST user message only,
 * so a trailing tool_result-only user message would read as empty text while the OpenAI side reads the
 * last user-role message's text. A tool message therefore carries, beside its tool_result block, a text
 * block with the nearest preceding user text: it changes nothing the parser echoes for any other
 * message, and makes the last message's text match.
 */
export function openAIToAnthropic(body: Json, model: string): Json {
  const source = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
  const systemParts: string[] = [];
  const messages: Json[] = [];
  for (let i = 0; i < source.length; i++) {
    const message = source[i];
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const content: Json[] = [];
      const text = textOf(message.content);
      if (text !== '') content.push({ type: 'text', text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        content.push({
          type: 'tool_use',
          id: typeof call.id === 'string' && call.id !== '' ? call.id : 'toolu_unknown',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          input: argumentsOf(call.function.arguments),
        });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    if (message.role === 'tool') {
      const prior = nearestUserText(source, i);
      const content: Json[] = [
        {
          type: 'tool_result',
          tool_use_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
          content: typeof message.content === 'string' ? message.content : toolResultText(message.content),
        },
      ];
      if (prior !== '') content.push({ type: 'text', text: prior });
      messages.push({ role: 'user', content });
      continue;
    }
    if (message.role !== 'user') continue;
    const content: Json[] = [];
    if (typeof message.content === 'string') {
      if (message.content !== '') content.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part)) continue;
        const block = blockOf(part);
        if (block !== null) content.push(block);
      }
    }
    if (content.length > 0) messages.push({ role: 'user', content });
  }

  const out: Json = { model, messages };
  if (systemParts.length > 0) out.system = systemParts.join('\n');
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  const stops = Array.isArray(body.stop) ? body.stop.filter((s) => typeof s === 'string') : typeof body.stop === 'string' ? [body.stop] : [];
  if (stops.length > 0) out.stop_sequences = stops;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [
        {
          name: raw.function.name,
          description: typeof raw.function.description === 'string' ? raw.function.description : '',
          input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'any') out.tool_choice = { type: 'any' };
  else if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function) && typeof choice.function.name === 'string') {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (body.stream === true) out.stream = true;
  return out;
}

/** One OpenAI tool definition as a Gemini function declaration. */
function geminiFunctionOf(raw: unknown): Json | null {
  if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return null;
  return {
    name: raw.function.name,
    description: typeof raw.function.description === 'string' ? raw.function.description : '',
    parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
  };
}

/** One Anthropic tool definition as a Gemini function declaration. */
function geminiFunctionOfAnthropic(raw: unknown): Json | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
  };
}

/** The generation config for a Gemini call: caps, stops, sampling, and JSON mode when asked. */
function geminiConfig(opts: {
  maxTokens?: number;
  stops?: string[];
  temperature?: number;
  topP?: number;
  json?: boolean;
}): Json {
  const config: Json = {};
  if (typeof opts.maxTokens === 'number') config.maxOutputTokens = opts.maxTokens;
  if (opts.stops !== undefined && opts.stops.length > 0) config.stopSequences = opts.stops;
  if (typeof opts.temperature === 'number') config.temperature = opts.temperature;
  if (typeof opts.topP === 'number') config.topP = opts.topP;
  if (opts.json === true) config.responseMimeType = 'application/json';
  return config;
}

/**
 * A Chat Completions request as a Gemini generateContent request. Returns the endpoint suffix
 * (`generateContent` or `streamGenerateContent`) and the body; the model goes in the URL path.
 * `needsJson` is true when the request asks for JSON mode.
 */
export function openAIToGemini(body: Json, needsJson: boolean): { endpoint: string; body: Json } {
  const source = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
  const systemParts: string[] = [];
  const contents: Json[] = [];
  for (let i = 0; i < source.length; i++) {
    const message = source[i];
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text !== '') contents.push({ role: 'model', parts: [{ text }] });
      continue;
    }
    if (message.role === 'tool') {
      const prior = nearestUserText(source, i);
      const parts: Json[] = [{ text: typeof message.content === 'string' ? message.content : toolResultText(message.content) }];
      if (prior !== '') parts.push({ text: prior });
      contents.push({ role: 'user', parts });
      continue;
    }
    if (message.role !== 'user') continue;
    const parts: Json[] = [];
    if (typeof message.content === 'string') {
      if (message.content !== '') parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
        else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const data = dataUrlParts(part.image_url.url);
          if (data !== null) parts.push({ inlineData: { mimeType: data.media, data: data.data } });
          else parts.push({ fileData: { fileUri: part.image_url.url, mimeType: 'image/png' } });
        }
      }
    }
    if (parts.length > 0) contents.push({ role: 'user', parts });
  }

  const out: Json = { contents };
  if (systemParts.length > 0) out.systemInstruction = { parts: [{ text: systemParts.join('\n') }] };
  if (Array.isArray(body.tools)) {
    const fns = body.tools.flatMap((raw) => {
      const fn = geminiFunctionOf(raw);
      return fn === null ? [] : [fn];
    });
    if (fns.length > 0) out.tools = [{ functionDeclarations: fns }];
  }
  const stops = Array.isArray(body.stop) ? body.stop.filter((s) => typeof s === 'string') : typeof body.stop === 'string' ? [body.stop] : [];
  out.generationConfig = geminiConfig({
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined,
    stops,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    json: needsJson,
  });
  return { endpoint: body.stream === true ? 'streamGenerateContent' : 'generateContent', body: out };
}

/**
 * An Anthropic Messages request as a Gemini generateContent request. `needsJson` is true when the
 * manifest says the request requires a JSON-capable model.
 */
export function anthropicToGemini(body: Json, needsJson: boolean): { endpoint: string; body: Json } {
  const system = textOf(body.system);
  const source = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
  const contents: Json[] = [];
  for (let i = 0; i < source.length; i++) {
    const message = source[i];
    if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text !== '') contents.push({ role: 'model', parts: [{ text }] });
      continue;
    }
    if (message.role !== 'user') continue;
    const parts: Json[] = [];
    if (typeof message.content === 'string') {
      if (message.content !== '') parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      let prior = '';
      for (let j = i - 1; j >= 0; j--) {
        if (source[j].role === 'user') {
          prior = textOf(source[j].content);
          break;
        }
      }
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text });
        else if (block.type === 'image' && isRecord(block.source)) {
          if (block.source.type === 'base64' && typeof block.source.data === 'string') {
            parts.push({ inlineData: { mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png', data: block.source.data } });
          } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
            parts.push({ fileData: { fileUri: block.source.url, mimeType: 'image/png' } });
          }
        } else if (block.type === 'tool_result') {
          parts.push({ text: toolResultText(block.content) });
          if (prior !== '') parts.push({ text: prior });
        }
      }
    }
    if (parts.length > 0) contents.push({ role: 'user', parts });
  }

  const out: Json = { contents };
  if (system !== '') out.systemInstruction = { parts: [{ text: system }] };
  if (Array.isArray(body.tools)) {
    const fns = body.tools.flatMap((raw) => {
      const fn = geminiFunctionOfAnthropic(raw);
      return fn === null ? [] : [fn];
    });
    if (fns.length > 0) out.tools = [{ functionDeclarations: fns }];
  }
  const stops = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s) => typeof s === 'string') : [];
  out.generationConfig = geminiConfig({
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    stops,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    json: needsJson,
  });
  return { endpoint: body.stream === true ? 'streamGenerateContent' : 'generateContent', body: out };
}

/* ------------------------------------------------------------------ */
/* Parsing one provider answer into an Answer.                        */
/* ------------------------------------------------------------------ */

/** Split SSE text into its frames: each frame's event name (or null) and data lines joined. */
function sseFrames(text: string): { event: string | null; data: string }[] {
  const frames: { event: string | null; data: string }[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  for (const frame of normalized.split('\n\n')) {
    if (frame.trim() === '') continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

function parseJsonObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A Chat Completions JSON answer as an Answer. */
export function parseOpenAIJson(text: string): Answer | null {
  const body = parseJsonObject(text);
  if (body === null) return null;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (choice === null) return null;
  const message = isRecord(choice.message) ? choice.message : null;
  if (message === null) return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    text: typeof message.content === 'string' ? message.content : textOf(message.content),
    inputTokens: numberOrZero(usage.prompt_tokens),
    outputTokens: numberOrZero(usage.completion_tokens),
    stop: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
  };
}

/** A Chat Completions SSE stream as an Answer: deltas concatenated, usage from the usage chunk. */
export function parseOpenAIStream(text: string): Answer | null {
  let out = '';
  let input = 0;
  let output = 0;
  let stop = 'stop';
  let sawAny = false;
  for (const frame of sseFrames(text)) {
    const payload = frame.data.trim();
    if (payload === '[DONE]') continue;
    const chunk = parseJsonObject(payload);
    if (chunk === null) continue;
    sawAny = true;
    if (isRecord(chunk.usage)) {
      input = numberOrZero(chunk.usage.prompt_tokens);
      output = numberOrZero(chunk.usage.completion_tokens);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string') out += delta.content;
    if (typeof choice.finish_reason === 'string') stop = choice.finish_reason;
  }
  if (!sawAny) return null;
  return { text: out, inputTokens: input, outputTokens: output, stop };
}

/** A Messages JSON answer as an Answer. */
export function parseAnthropicJson(text: string): Answer | null {
  const body = parseJsonObject(text);
  if (body === null || body.type !== 'message' || !Array.isArray(body.content)) return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    text: body.content
      .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
      .join(''),
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    stop: typeof body.stop_reason === 'string' ? body.stop_reason : 'end_turn',
  };
}

/** A Messages SSE stream as an Answer: text deltas concatenated, usage from start and delta. */
export function parseAnthropicStream(text: string): Answer | null {
  let out = '';
  let input = 0;
  let output = 0;
  let stop = 'end_turn';
  let sawAny = false;
  for (const frame of sseFrames(text)) {
    const data = parseJsonObject(frame.data);
    if (data === null) continue;
    sawAny = true;
    if (frame.event === 'message_start' && isRecord(data.message) && isRecord(data.message.usage)) {
      input = numberOrZero(data.message.usage.input_tokens);
    }
    if (frame.event === 'content_block_delta' && isRecord(data.delta) && data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
      out += data.delta.text;
    }
    if (frame.event === 'message_delta') {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') stop = data.delta.stop_reason;
      if (isRecord(data.usage)) output = numberOrZero(data.usage.output_tokens);
    }
  }
  if (!sawAny) return null;
  return { text: out, inputTokens: input, outputTokens: output, stop };
}

/** A Gemini generateContent JSON answer as an Answer. */
export function parseGeminiJson(text: string): Answer | null {
  const body = parseJsonObject(text);
  if (body === null) return null;
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate === null) return null;
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    text: parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join(''),
    inputTokens: numberOrZero(usage.promptTokenCount),
    outputTokens: numberOrZero(usage.candidatesTokenCount),
    stop: typeof candidate.finishReason === 'string' ? candidate.finishReason : 'STOP',
  };
}

/** A Gemini streamGenerateContent SSE stream as an Answer. */
export function parseGeminiStream(text: string): Answer | null {
  let out = '';
  let input = 0;
  let output = 0;
  let stop = 'STOP';
  let sawAny = false;
  for (const frame of sseFrames(text)) {
    const data = parseJsonObject(frame.data);
    if (data === null) continue;
    sawAny = true;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const candidate = isRecord(candidates[0]) ? candidates[0] : null;
    if (candidate !== null) {
      const content = isRecord(candidate.content) ? candidate.content : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      out += parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join('');
      if (typeof candidate.finishReason === 'string') stop = candidate.finishReason;
    }
    if (isRecord(data.usageMetadata)) {
      input = numberOrZero(data.usageMetadata.promptTokenCount);
      output = numberOrZero(data.usageMetadata.candidatesTokenCount);
    }
  }
  if (!sawAny) return null;
  return { text: out, inputTokens: input, outputTokens: output, stop };
}

/* ------------------------------------------------------------------ */
/* Rendering one Answer in the client's wire.                         */
/* ------------------------------------------------------------------ */

/** Split text into pieces of at most `n` characters, for stream deltas. */
function splitText(text: string, n: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += n) pieces.push(text.slice(at, at + n));
  return pieces.length === 0 ? [''] : pieces;
}

/** An Answer as a Chat Completions JSON object. */
export function renderOpenAIJson(answer: Answer, model: string): Json {
  return {
    id: 'chatcmpl-tortoise',
    object: 'chat.completion',
    created: FIXED_OPENAI_CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
  };
}

/** An Answer as a Chat Completions SSE stream: role chunk, content deltas, finish chunk, usage chunk, [DONE]. */
export function renderOpenAIStream(answer: Answer, model: string): string {
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-tortoise',
    object: 'chat.completion.chunk',
    created: FIXED_OPENAI_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames: string[] = [sseEvent(null, chunk({ role: 'assistant', content: '' }, null))];
  for (const piece of splitText(answer.text, 64)) frames.push(sseEvent(null, chunk({ content: piece }, null)));
  frames.push(sseEvent(null, chunk({}, 'stop')));
  frames.push(
    sseEvent(null, {
      id: 'chatcmpl-tortoise',
      object: 'chat.completion.chunk',
      created: FIXED_OPENAI_CREATED,
      model,
      choices: [],
      usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
    }),
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

/** An Answer as a Messages JSON object. */
export function renderAnthropicJson(answer: Answer, model: string): Json {
  return {
    id: 'msg_tortoise',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
  };
}

/** An Answer as a Messages SSE stream: start, one text block, delta, stop, delta, stop. */
export function renderAnthropicStream(answer: Answer, model: string): string {
  const frames: string[] = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tortoise',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.inputTokens, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (const piece of splitText(answer.text, 64)) {
    frames.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
  }
  frames.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
  frames.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: answer.outputTokens },
    }),
  );
  frames.push(sseEvent('message_stop', { type: 'message_stop' }));
  return frames.join('');
}
