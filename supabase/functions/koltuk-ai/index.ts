// Koltuk AI — Pazar check-in asistanı
//
// Anahtar sunucuda kalır, tarayıcıya hiç inmez. Hangi sağlayıcının anahtarı
// tanımlıysa o kullanılır (provider.ts) — Gemini ve Groq'un ücretsiz katmanı
// bu iş için fazlasıyla yeterli. Hiç anahtar yoksa fonksiyon 501 döner ve
// uygulama kendi kural tabanlı özetini gösterir.
//
// Kurulum (ücretsiz):
//   supabase secrets set GEMINI_API_KEY=...      # aistudio.google.com
//   supabase functions deploy koltuk-ai

import { callModel, CORS, json, activeProvider } from "./provider.ts";

const SYSTEM = `Sen "Koltuk" adlı kişisel hayat sisteminin pazar check-in asistanısın.
Kullanıcı 26 yaşında, İstanbul'da yaşıyor, Türkçe konuşuyor. Sistemin kuralları:

- Aynı anda sadece 3 aktif alan vardır. Dördüncüsü Park'ta bekler.
- %70 yeter: 7/7 değil, 5/7 çapa başarılı bir haftadır.
- Haftada bir "akış günü" vardır: plansız, işaretsiz, suçsuz. Eksik sayılmaz.
- Yeni her istek 30 gün Park'ta bekler.
- Kullanıcı mükemmeliyetçiliğiyle ve başladığını bitirememekle uğraşıyor.
- Sistemin bir "pusulası" var: bu yılın yönü ve bu çeyreğin odağı. Önerilerin
  bununla çelişmemeli; çelişiyorsa çelişkiyi söyle, kendin yeni yön icat etme.
- Bu sistem yıllarca kullanılacak. Bir ayın kötü geçmesi sistemin bozulduğu
  anlamına gelmez; öyleymiş gibi yazma.

Üslubun: Türkçe, kısa, doğrudan, sıcak ama yağcı değil. Terapist dili yok,
motivasyon sloganı yok. Kötü giden bir şey varsa yumuşatmadan söyle; ama
suçlama ve "daha çok çabala" deme — sistemin kendisini ayarlamayı öner.
Rakam uydurma, sadece sana verilen veriye dayan.`;

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Geçen haftanın 2-3 cümlelik dürüst özeti. Rakamlara dayan.",
    },
    commitments: {
      type: "array",
      description: "Aktif alan başına tam 1 taahhüt, verilen alan sırasıyla.",
      items: {
        type: "object",
        properties: {
          area: { type: "string", description: "Alan id'si (a1/a2/a3)" },
          text: { type: "string", description: "Tek somut adım, en fazla 12 kelime." },
        },
        required: ["area", "text"],
      },
    },
    no_sentence: {
      type: "string",
      description: "Bu hafta gelebilecek bir isteğe karşı tek cümlelik kibar hayır.",
    },
    watch: {
      type: "string",
      description: "Sistemde sürüklenen tek nokta. Tek cümle.",
    },
  },
  required: ["summary", "commitments", "no_sentence", "watch"],
};

const MONTHLY_SCHEMA = {
  type: "object",
  properties: {
    review: {
      type: "string",
      description:
        "Ayın 3-4 cümlelik kapanış notu: hedefler tuttu mu, çapalar ne durumda, " +
        "ne sürüklendi. Geçmiş aylarla kıyas varsa belirt. Rakamlara dayan.",
    },
    next_theme: {
      type: "string",
      description: "Gelecek ay için tek cümlelik tema önerisi. Pusulayla uyumlu olsun.",
    },
    next_goals: {
      type: "array",
      description: "Gelecek ay için alan başına tam 1 hedef, verilen alan sırasıyla.",
      items: {
        type: "object",
        properties: {
          area: { type: "string", description: "Alan id'si (a1/a2/a3)" },
          text: { type: "string", description: "Ay içinde bitebilecek tek hedef." },
        },
        required: ["area", "text"],
      },
    },
    watch: { type: "string", description: "Aylardır sürüklenen tek şey. Tek cümle." },
  },
  required: ["review", "next_theme", "next_goals", "watch"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405);

  if (!activeProvider()) {
    return json({
      error: "NO_PROVIDER",
      message:
        "Hiçbir model anahtarı tanımlı değil. Supabase → Edge Functions → Secrets " +
        "kısmına GEMINI_API_KEY (ücretsiz) ekleyebilirsin.",
    }, 501);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Geçersiz JSON" }, 400);
  }

  const monthly = payload?.mode === "monthly";

  try {
    const out = await callModel(
      SYSTEM,
      (monthly
        ? "Aşağıdaki veri kullanıcının biten ayı ve sistem geçmişi. Ayın kapanış " +
          "notunu yaz ve gelecek ayı öner.\n\n"
        : "Aşağıdaki veri, kullanıcının Koltuk sistemindeki güncel durumu. " +
          "Pazar check-in'ini hazırla.\n\n") + JSON.stringify(payload, null, 2),
      monthly ? MONTHLY_SCHEMA : SCHEMA,
      monthly ? "month_close" : "check_in",
    );
    return json(out);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 502);
  }
});
