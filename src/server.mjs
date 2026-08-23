import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  PUBLIC_EVENTS,
  OPERATOR_EVENTS,
  FINANCIAL_EVENTS,
  validateEventName,
  sanitizeText,
} from "./telemetry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const eventFile = join(dataDir, "events.ndjson");
const port = Number(process.env.PORT || 4173);
const whatsappNumber = (process.env.WHATSAPP_NUMBER || "").replace(/\D/g, "");
const operatorToken = process.env.OPERATOR_TOKEN || "";
await mkdir(dataDir, { recursive: true });

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("payload_too_large");
  }
  return body ? JSON.parse(body) : {};
}

async function persistEvent(event) {
  await appendFile(eventFile, `${JSON.stringify(event)}\n`, "utf8");
}

function buildEvent(name, payload = {}, source = "public") {
  return {
    id: randomUUID(),
    name,
    source,
    occurred_at: new Date().toISOString(),
    session_id: sanitizeText(payload.session_id, 80),
    experiment_id: sanitizeText(payload.experiment_id, 80) || "EXP-0001",
    offer_id: sanitizeText(payload.offer_id, 80) || "OFFER-0001",
    channel: sanitizeText(payload.channel, 40),
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, {
        whatsapp_enabled: Boolean(whatsappNumber),
        whatsapp_number: whatsappNumber,
        offer_id: "OFFER-0001",
        experiment_id: "EXP-0001",
      });
    }

    if (req.method === "POST" && url.pathname === "/api/events/public") {
      const payload = await readJson(req);
      const name = sanitizeText(payload.name, 60);
      if (!validateEventName(name) || !PUBLIC_EVENTS.has(name)) {
        return json(res, 400, { error: "event_not_allowed" });
      }
      await persistEvent(buildEvent(name, payload, "public"));
      return json(res, 202, { accepted: true });
    }

    if (req.method === "POST" && url.pathname === "/api/events/operator") {
      if (!operatorToken || req.headers.authorization !== `Bearer ${operatorToken}`) {
        return json(res, 401, { error: "operator_auth_required" });
      }
      const payload = await readJson(req);
      const name = sanitizeText(payload.name, 60);
      if (!validateEventName(name) || !OPERATOR_EVENTS.has(name)) {
        return json(res, 400, { error: "event_not_allowed" });
      }
      await persistEvent(buildEvent(name, payload, "operator"));
      return json(res, 202, { accepted: true });
    }
    if (req.method === "POST" && url.pathname === "/api/events/financial") {
      const payload = await readJson(req);
      const name = sanitizeText(payload.name, 60);
      if (!FINANCIAL_EVENTS.has(name)) {
        return json(res, 400, { error: "event_not_allowed" });
      }
      return json(res, 503, { error: "payment_provider_not_configured" });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(publicDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return json(res, message === "payload_too_large" ? 413 : 500, { error: message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Projeto Zero G2 em http://127.0.0.1:${port}`);
  console.log(whatsappNumber ? "WhatsApp configurado" : "WhatsApp NAO configurado; CTA permanece bloqueado");
  console.log("Eventos financeiros bloqueados ate integracao autenticada com provedor");
});
