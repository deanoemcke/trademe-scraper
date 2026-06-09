// Server-side only — AI provider configuration and JSON completion helper.

const AI_PROVIDERS: Record<string, { url: string; model: string; keyVar: string }> = {
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',                          model: 'llama-3.3-70b-versatile',           keyVar: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                            model: 'meta-llama/llama-3.3-70b-instruct', keyVar: 'OPENROUTER_API_KEY' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.1-flash-lite',              keyVar: 'GEMINI_API_KEY' },
};

export type AiConfig = { url: string; model: string; apiKey: string };

export function getAIConfig(): AiConfig | string {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig) return `Unknown AI_PROVIDER "${provider}" — use groq, openrouter, or gemini`;
  const apiKey = process.env[providerConfig.keyVar];
  if (!apiKey) return `${providerConfig.keyVar} is not set`;
  return { url: providerConfig.url, model: providerConfig.model, apiKey };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function aiJSON(aiConfig: AiConfig, label: string, systemMessage: string, userMessage: string, maxTokens: number): Promise<any> {
  const trim = (text: string) => text.replace(/\s+/g, ' ').slice(0, 100);
  console.log(`[AI] ${label} → model: ${aiConfig.model}\n[system] ${trim(systemMessage)}…\n[user] ${trim(userMessage)}…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let apiResponse: Response;
  try {
    apiResponse = await fetch(aiConfig.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${aiConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiConfig.model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!apiResponse.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorData = await apiResponse.json().catch(() => ({})) as any;
    const errorBody = Array.isArray(errorData) ? errorData[0] : errorData;
    const errorMessage = errorBody?.error?.message ?? errorBody?.message ?? JSON.stringify(errorData);
    throw new Error(`AI error (${label}) [${apiResponse.status}]: ${errorMessage || apiResponse.statusText}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responseData = await apiResponse.json() as any;
  const raw: string = responseData.choices?.[0]?.message?.content ?? '{}';
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
