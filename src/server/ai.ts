// Server-side only — AI provider configuration and JSON completion helper.

const AI_PROVIDERS: Record<string, { url: string; model: string; keyVar: string }> = {
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',                          model: 'llama-3.3-70b-versatile',           keyVar: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                            model: 'meta-llama/llama-3.3-70b-instruct', keyVar: 'OPENROUTER_API_KEY' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.1-flash-lite',              keyVar: 'GEMINI_API_KEY' },
};

export type AiConfig = { url: string; model: string; apiKey: string };

export function getAIConfig(): AiConfig | string {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return `Unknown AI_PROVIDER "${provider}" — use groq, openrouter, or gemini`;
  const apiKey = process.env[cfg.keyVar];
  if (!apiKey) return `${cfg.keyVar} is not set`;
  return { url: cfg.url, model: cfg.model, apiKey };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function aiJSON(cfg: AiConfig, label: string, systemMsg: string, userMsg: string, maxTokens: number): Promise<any> {
  const trim = (s: string) => s.replace(/\s+/g, ' ').slice(0, 100);
  console.log(`[AI] ${label} → model: ${cfg.model}\n[system] ${trim(systemMsg)}…\n[user] ${trim(userMsg)}…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let r: Response;
  try {
    r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = await r.json().catch(() => ({})) as any;
    const body = Array.isArray(e) ? e[0] : e;
    const msg = body?.error?.message ?? body?.message ?? JSON.stringify(e);
    throw new Error(`AI error (${label}) [${r.status}]: ${msg || r.statusText}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await r.json() as any;
  const raw: string = d.choices?.[0]?.message?.content ?? '{}';
  // Extract JSON from a markdown code fence if the model wrapped it in prose
  let stripped: string;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    stripped = fenceMatch[1].trim();
  } else {
    // Fallback: grab from first { to last }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    stripped = jsonMatch ? jsonMatch[0].trim() : raw.trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    throw new Error(`AI parse error (${label}): ${stripped.slice(0, 200)}`);
  }
}
