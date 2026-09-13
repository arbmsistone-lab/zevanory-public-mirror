import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  PUBLIC_EVENTS,
  OPERATOR_EVENTS,
  FINANCIAL_EVENTS,
  validateEventName,
  sanitizeText,
} from "./telemetry.mjs";
import { PROJECT, normalizeWhatsappNumber, isOfficialWhatsapp, isUuid } from "./config.mjs";
import { safeBearerEqual } from "./security.mjs";
import configApi from "../api/config.mjs";
import statusApi from "../api/status.mjs";
import releaseApi from "./http/release.mjs";
import agentStatusApi from "../api/agent-status.mjs";
import assuranceApi from "./http/assurance.mjs";
import financeApi from "./http/finance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const eventFile = join(dataDir, "events.ndjson");
const port = Number(process.env.PORT || 4173);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const configuredWhatsappNumber = normalizeWhatsappNumber(process.env.WHATSAPP_NUMBER);
const whatsappNumber = isOfficialWhatsapp(configuredWhatsappNumber) ? configuredWhatsappNumber : "";
const operatorToken = String(process.env.OPERATOR_TOKEN || "").trim();
await mkdir(dataDir, { recursive: true });
const STATIC_ROUTES = new Map([
  ["/", "index.html"], ["/index.html", "index.html"], ["/arbm-sist", "arbm-sist.html"], ["/piloto", "piloto.html"],
  ["/termos", "termos.html"], ["/privacidade", "privacidade.html"], ["/reembolso", "reembolso.html"], ["/afiliados", "afiliados.html"], ["/tiktok-review", "tiktok-review.html"],
  ["/criativos", "criativos.html"], ["/zevanory-robot-control", "zevanory-robot-control.html"],
]);
const STATIC_TYPES = Object.freeze({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml; charset=utf-8'});
function staticAsset(pathname) {
  let relative=STATIC_ROUTES.get(pathname);
  if(!relative && /^\/(?:brand\/)?[A-Za-z0-9._/-]+\.(?:css|js|svg|html)$/.test(pathname)) relative=pathname.slice(1);
  if(!relative) return null;
  const clean=normalize(relative).replace(/^[/\\]+/,'');
  const absolute=resolve(publicDir,clean); const base=resolve(publicDir)+sep;
  if(!absolute.startsWith(base)) return null;
  const contentType=STATIC_TYPES[extname(absolute).toLowerCase()];
  return contentType?{absolute,contentType}:null;
}
async function serveStatic(req,res,pathname) {
  const asset=staticAsset(pathname); if(!asset) return false;
  let data; try { data=await readFile(asset.absolute); } catch(error) { if(error?.code==='ENOENT') return false; throw error; }
  res.writeHead(200,{'content-type':asset.contentType,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'"});
  if(req.method==='HEAD') return res.end(); res.end(data); return true;
}
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) {
      const error = new Error("payload_too_large");
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}
async function persistEvent(event) {
  await appendFile(eventFile, `${JSON.stringify(event)}\n`, "utf8");
}

function buildEvent(name, payload = {}, source = "public") {
  const sessionId = sanitizeText(payload.session_id, 80);
  if (!isUuid(sessionId)) {
    const error = new Error("invalid_session_id");
    error.statusCode = 400;
    throw error;
  }
  return {
    id: randomUUID(),
    name,
    source,
    occurred_at: new Date().toISOString(),
    session_id: sessionId,
    experiment_id: PROJECT.experimentId,
    offer_id: PROJECT.offerId,
    channel: sanitizeText(payload.channel, 40),
  };
}

function authorizedOperator(req) {
  return safeBearerEqual(operatorToken, String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
}
const READ_API_HANDLERS = new Map([
  ['/api/config',configApi], ['/api/status',statusApi], ['/api/health',statusApi], ['/api/release',releaseApi],
  ['/api/agent/status',agentStatusApi], ['/api/assurance',assuranceApi], ['/api/finance',financeApi], ['/api/live',statusApi], ['/api/activation/readiness',configApi],
]);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && READ_API_HANDLERS.has(url.pathname)) {
      if(url.pathname==='/api/activation/readiness') req.url='/api/config?view=activation';
      if(url.pathname==='/api/live') req.url='/api/status?probe=live';
      if(url.pathname==='/api/health') req.url='/api/status?probe=health';
      return READ_API_HANDLERS.get(url.pathname)(req,res);
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
      if (!authorizedOperator(req)) {
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
    if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(req,res,url.pathname)) return;

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = Number(error?.statusCode) || 500;
    return json(res, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`ZEVANORY G2 em http://${host}:${port}`);
  console.log(whatsappNumber ? "WhatsApp configurado" : "WhatsApp NAO configurado; CTA bloqueado");
  console.log("Eventos financeiros bloqueados ate integracao autenticada com provedor");
});
