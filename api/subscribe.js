// Vercel serverless function: captura de correos para el beneficio Whitepaper x Banco Plata.
//
// No existe una API pública oficial de Substack para dar de alta suscriptores
// "Comp" en tiempo real. Este endpoint valida y reenvía el correo a un webhook
// externo (por ejemplo un escenario de Make.com/Zapier) que lo agrega a una
// hoja/Airtable para su importación semanal por CSV a Substack.
//
// Variables de entorno requeridas (configurar en el proyecto de Vercel):
//   SUBSCRIBE_WEBHOOK_URL   URL del webhook (Make.com, Zapier, etc.) que recibe el lead.
//   SUBSCRIBE_WEBHOOK_TOKEN (opcional) token compartido enviado como header para autenticar la llamada.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

// Límite simple de solicitudes por IP en memoria (best-effort; se reinicia con cada cold start).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes. Intenta de nuevo en un minuto." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Cuerpo de la solicitud inválido." });
    }
  }
  body = body || {};

  // Honeypot: si el campo trampa viene lleno, es un bot. Respondemos 200 sin hacer nada.
  if (typeof body.company === "string" && body.company.trim() !== "") {
    return res.status(200).json({ ok: true });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const source = typeof body.source === "string" ? body.source.slice(0, 64) : "banco-plata";

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: "Ingresa un correo válido." });
  }

  const webhookUrl = process.env.SUBSCRIBE_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("SUBSCRIBE_WEBHOOK_URL no está configurado.");
    return res.status(500).json({ error: "El servicio no está disponible en este momento." });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const webhookRes = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SUBSCRIBE_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.SUBSCRIBE_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        email,
        source,
        program: "whitepaper-x-banco-plata",
        submittedAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!webhookRes.ok) {
      console.error("Webhook de suscripción respondió con error:", webhookRes.status);
      return res.status(502).json({ error: "No pudimos registrar tu correo. Intenta de nuevo." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error al reenviar la suscripción:", err);
    return res.status(502).json({ error: "No pudimos registrar tu correo. Intenta de nuevo." });
  }
};
