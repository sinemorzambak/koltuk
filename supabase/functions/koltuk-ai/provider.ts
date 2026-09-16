/* ---------------------------------------------------------------
   Sağlayıcıdan bağımsız model çağrısı.
   Hangi anahtar tanımlıysa o kullanılır — hepsi ücretsiz katmanı olan
   servisler. Çıktı her durumda şemaya uygun JSON'dur.

   Desteklenen ortam değişkenleri (biri yeterli):
     GEMINI_API_KEY      Google AI Studio — ücretsiz katman, kart istemez
     GROQ_API_KEY        Groq — ücretsiz katman
     OPENROUTER_API_KEY  OpenRouter — ":free" ile biten modeller ücretsiz
     ANTHROPIC_API_KEY   Anthropic — ücretli

   İsteğe bağlı:
     AI_PROVIDER   gemini | groq | openrouter | anthropic  (otomatik seçimi ezer)
     AI_MODEL      model adı (boşsa sağlayıcıdan uygun ilk model seçilir)
   --------------------------------------------------------------- */

export type Json = Record<string, unknown>;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const env = (k: string) => Deno.env.get(k) ?? "";

export function activeProvider(): string | null {
  const forced = env("AI_PROVIDER").toLowerCase();
  if (forced) return forced;
  if (env("GEMINI_API_KEY")) return "gemini";
  if (env("GROQ_API_KEY")) return "groq";
  if (env("OPENROUTER_API_KEY")) return "openrouter";
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  return null;
}

/* Gemini şema tipleri büyük harf ister; desteklemediği anahtarları atıyoruz. */
function toGeminiSchema(s: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type") out.type = String(v).toUpperCase();
    else if (k === "properties") {
      const p: Json = {};
      for (const [pk, pv] of Object.entries(v as Json)) p[pk] = toGeminiSchema(pv as Json);
      out.properties = p;
    } else if (k === "items") out.items = toGeminiSchema(v as Json);
    else if (k === "required" || k === "description") out[k] = v;
  }
  return out;
}

/* Model adı verilmemişse sağlayıcının listesinden uygun ilkini seçer.
   Böylece model isimleri değiştiğinde fonksiyon kendini onarır. */
async function pickModel(provider: string, key: string): Promise<string> {
  const forced = env("AI_MODEL");
  if (forced) return forced;

  if (provider === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
    );
    if (!r.ok) throw new Error(`Model listesi alınamadı (${r.status})`);
    const d = await r.json();
    const usable = (d.models ?? []).filter((m: { supportedGenerationMethods?: string[] }) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent")
    ).map((m: { name: string }) => m.name.replace(/^models\//, ""));
    const flash = usable.find((n: string) => n.includes("flash") && !n.includes("thinking"));
    if (!flash && !usable.length) throw new Error("Kullanılabilir Gemini modeli bulunamadı");
    return flash ?? usable[0];
  }

  if (provider === "groq") {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`Model listesi alınamadı (${r.status})`);
    const d = await r.json();
    const ids = (d.data ?? []).map((m: { id: string }) => m.id)
      .filter((id: string) => !/whisper|tts|guard|vision/i.test(id));
    const pref = ids.find((id: string) => /llama.*(70b|versatile)/i.test(id)) ??
      ids.find((id: string) => /llama/i.test(id));
    if (!pref && !ids.length) throw new Error("Kullanılabilir Groq modeli bulunamadı");
    return pref ?? ids[0];
  }

  if (provider === "openrouter") return "meta-llama/llama-3.3-70b-instruct:free";
  return "claude-haiku-4-5";
}

/** system + kullanıcı metni + JSON şeması → şemaya uyan nesne */
export async function callModel(
  system: string,
  userText: string,
  schema: Json,
  toolName: string,
): Promise<Json> {
  const provider = activeProvider();
  if (!provider) throw new Error("NO_PROVIDER");

  const keyName = provider === "gemini"
    ? "GEMINI_API_KEY"
    : provider === "groq"
    ? "GROQ_API_KEY"
    : provider === "openrouter"
    ? "OPENROUTER_API_KEY"
    : "ANTHROPIC_API_KEY";
  const key = env(keyName);
  if (!key) throw new Error(`${keyName} tanımlı değil`);

  const model = await pickModel(provider, key);

  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        tools: [{ name: toolName, description: "Yapılandırılmış çıktı", input_schema: schema }],
        tool_choice: { type: "tool", name: toolName },
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic hatası (${r.status}): ${await r.text()}`);
    const d = await r.json();
    const block = (d.content ?? []).find((c: { type: string }) => c.type === "tool_use");
    if (!block) throw new Error("Model yapılandırılmış cevap döndürmedi");
    return { ...block.input, _model: model, _provider: provider };
  }

  if (provider === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(schema),
            maxOutputTokens: 1600,
          },
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini hatası (${r.status}): ${await r.text()}`);
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    if (!text) throw new Error("Gemini boş cevap döndürdü");
    return { ...JSON.parse(text), _model: model, _provider: provider };
  }

  /* groq + openrouter: OpenAI uyumlu uç nokta */
  const base = provider === "groq"
    ? "https://api.groq.com/openai/v1"
    : "https://openrouter.ai/api/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: system +
            "\n\nCevabını SADECE şu JSON şemasına uyan tek bir JSON nesnesi olarak ver, " +
            "başka hiçbir metin yazma:\n" + JSON.stringify(schema),
        },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!r.ok) throw new Error(`${provider} hatası (${r.status}): ${await r.text()}`);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error(`${provider} boş cevap döndürdü`);
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  return { ...JSON.parse(cleaned), _model: model, _provider: provider };
}
