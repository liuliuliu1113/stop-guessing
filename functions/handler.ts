const SYSTEM = `你是一个帮人从"过度推演"里走出来的助手。用户会给你一句他反复在想的推测、
和谁的关系、已经想了多久。
你的任务不是安慰他，也不是分析对方，而是：
1) 一句话指出他从"事实"直接跳到"结论"的那个缺口；
2) 把他的原话拆成"能验证的事实"和"没法验证的猜测"；
3) 给出 5 个他可能没想到的其他解释，必须互不重复、覆盖不同维度；
4) 给一个今天就能做的具体动作，并附一句能直接复制发出去的话。
只输出 JSON，不要解释文字，不要 markdown 代码块。结构：
{"body":"不超过40字","facts":[""],"guesses":[""],
"others":[{"text":"不超过20字","kind":"客观|关系|时间|性格|意外"}],
"action":{"title":"不超过12字","why":"不超过30字","say":"第一人称、可直接发送的一句话","time":"不超过10字"},
"alternatives":[{"title":"不超过8字","desc":"不超过25字"}]}
硬性要求：others 恰好 5 条；不要评判用户；不要预测对方内心；不要给操控、试探、查岗类建议；
say 必须是用户能直接复制发出去的第一人称句子，不要写"你可以这样说"。`;

const MODEL = Deno.env.get("LLM_MODEL") ?? "deepseek-chat";
const MAX_THOUGHT_LENGTH = 120;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const KINDS = new Set(["客观", "关系", "时间", "性格", "意外"]);
const RESPONSE_HEADERS = { "content-type": "application/json; charset=utf-8" };

type RateEntry = { count: number; resetAt: number };
type Report = {
  body: string;
  facts: string[];
  guesses: string[];
  others: { text: string; kind: string }[];
  action: { title: string; why: string; say: string; time: string };
  alternatives: { title: string; desc: string }[];
};

const rateLimit = new Map<string, RateEntry>();

class UpstreamError extends Error {}
class InvalidOutputError extends Error {}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringList(value: unknown, min: number, max: number): string[] | null {
  const source = typeof value === "string" ? [value] : value;
  if (!Array.isArray(source) || source.length < min || source.length > max) {
    return null;
  }
  const items: string[] = [];
  for (const item of source) {
    const text = nonEmptyString(item);
    if (!text) return null;
    items.push(text);
  }
  return items;
}

function normalizeKind(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  if (KINDS.has(text)) return text;
  for (const kind of KINDS) {
    if (text.includes(kind)) return kind;
  }
  return null;
}

function parseOthers(value: unknown): Report["others"] | null {
  if (!Array.isArray(value) || value.length < 5) return null;
  const items: Report["others"] = [];
  for (const item of value.slice(0, 5)) {
    if (!isObject(item)) return null;
    const text = nonEmptyString(item.text);
    const kind = normalizeKind(item.kind);
    if (!text || !kind) return null;
    items.push({ text, kind });
  }
  return items;
}

function parseAction(value: unknown): Report["action"] | null {
  if (!isObject(value)) return null;
  const title = nonEmptyString(value.title);
  const why = nonEmptyString(value.why);
  const say = nonEmptyString(value.say);
  const time = nonEmptyString(value.time);
  if (!title || !why || !say || !time) return null;
  return { title, why, say, time };
}

function parseAlternatives(value: unknown): Report["alternatives"] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const items: Report["alternatives"] = [];
  for (const item of value.slice(0, 2)) {
    if (!isObject(item)) return null;
    const title = nonEmptyString(item.title);
    const desc = nonEmptyString(item.desc);
    if (!title || !desc) return null;
    items.push({ title, desc });
  }
  return items;
}

function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return null;
}

type ParseFailure =
  | "invalid_json"
  | "body"
  | "facts"
  | "guesses"
  | "others"
  | "action"
  | "alternatives";

type ParseResult = { report: Report } | { failure: ParseFailure };

function parseReport(content: string): ParseResult {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    const extracted = extractJsonObject(cleaned);
    if (!extracted) return { failure: "invalid_json" };
    try {
      value = JSON.parse(extracted);
    } catch {
      return { failure: "invalid_json" };
    }
  }
  if (!isObject(value)) return { failure: "invalid_json" };

  const body = nonEmptyString(value.body);
  if (!body) return { failure: "body" };

  const facts = stringList(value.facts, 1, 6);
  if (!facts) return { failure: "facts" };

  const guesses = stringList(value.guesses, 1, 6);
  if (!guesses) return { failure: "guesses" };

  const others = parseOthers(value.others);
  if (!others) return { failure: "others" };

  const action = parseAction(value.action);
  if (!action) return { failure: "action" };

  const alternatives = parseAlternatives(value.alternatives);
  if (!alternatives) return { failure: "alternatives" };

  return {
    report: {
      body,
      facts: facts.slice(0, 3),
      guesses: guesses.slice(0, 3),
      others,
      action,
      alternatives,
    },
  };
}

function upstreamContent(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    return null;
  }
  const choice = value.choices[0];
  if (!isObject(choice) || !isObject(choice.message)) return null;
  return nonEmptyString(choice.message.content);
}

async function callUpstream(
  endpoint: string,
  apiKey: string,
  userContent: string
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    console.error("upstream_fetch_failed");
    throw new UpstreamError();
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // 上游错误内容不读取、不返回。
    }
    throw new UpstreamError();
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidOutputError();
    throw new UpstreamError();
  }

  const content = upstreamContent(data);
  if (!content) throw new InvalidOutputError();
  return content;
}

function rateLimitKey(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  if (rateLimit.size > 500) {
    for (const [entryKey, entry] of rateLimit) {
      if (entry.resetAt <= now) rateLimit.delete(entryKey);
    }
  }
  const entry = rateLimit.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimit.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_REQUESTS) return true;
  entry.count += 1;
  return false;
}

export async function handleApp(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json(200, { ok: true });
  }
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }

  const apiKey = Deno.env.get("LLM_API_KEY");
  const baseUrl = Deno.env.get("LLM_BASE_URL");
  if (!apiKey || !baseUrl) {
    return json(503, { error: "service_not_configured" });
  }

  if (isRateLimited(rateLimitKey(request))) {
    return json(429, { error: "rate_limited" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!isObject(body) || typeof body.thought !== "string") {
    return json(400, { error: "bad_request" });
  }

  const thought = body.thought.trim();
  if (!thought) {
    return json(400, { error: "bad_request" });
  }
  if (thought.length > MAX_THOUGHT_LENGTH) {
    return json(400, { error: "too_long" });
  }

  const relation = typeof body.relation === "string" ? body.relation.trim() : "";
  const duration = typeof body.duration === "string" ? body.duration.trim() : "";
  const userContent = [
    `用户反复在想：${thought}`,
    `和谁的关系：${relation || "未说明"}`,
    `已经想了多久：${duration || "未说明"}`,
    "输出必须严格满足：facts 1-3 条；guesses 1-3 条；others 恰好 5 条；alternatives 恰好 2 条；kind 只能是 客观、关系、时间、性格、意外。",
  ].join("\n");

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content: string;
    try {
      content = await callUpstream(endpoint, apiKey, userContent);
    } catch (error) {
      if (error instanceof UpstreamError) {
        return json(502, { error: "upstream_failed", fallback: true });
      }
      console.error("upstream_output_invalid");
      continue;
    }

    const parsed = parseReport(content);
    if ("report" in parsed) return json(200, parsed.report);
    console.error(`report_validation_failed:${parsed.failure}`);
  }

  return json(502, { error: "bad_output", fallback: true });
}
