// 20 canonical product questions (4 per product) + safety cases for the
// grounded support knowledge route. Fails closed on any wrong/invented answer.
import { answerSupportQuestion, handleSupportKnowledge, SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import fs from "node:fs";

const failures = [];
let correct = 0;
const expectPrices = { "ia-na-pratica": "R$ 197,00", "vendas-na-pratica": "R$ 197,00", "lucro-e-caixa": "R$ 247,00", "combo-ia-vendas": "R$ 297,00", "negocio-completo": "R$ 397,00" };

// Prices must match the approved, published sales pages.
const ov = JSON.parse(fs.readFileSync(new URL("../sales-overlay/approved.json", import.meta.url), "utf8"));
for (const [slug, block] of Object.entries(ov.offers)) {
  const published = Number((block.match(/R\$ (\d+)/) || [])[1]);
  if (SUPPORT_PRODUCTS[slug]?.price_brl !== published) failures.push(`${slug}: knowledge price ${SUPPORT_PRODUCTS[slug]?.price_brl} != published ${published}`);
}

const cases = [];
for (const slug of Object.keys(SUPPORT_PRODUCTS)) {
  const name = SUPPORT_PRODUCTS[slug].name;
  cases.push([slug, `Quanto custa o ${name}?`, "price", (a) => a.includes(expectPrices[slug])]);
  cases.push([slug, "Posso pedir reembolso se não gostar?", "refund", (a) => /7 dias/.test(a) && /reembolso integral/.test(a)]);
  cases.push([slug, "Como recebo o acesso depois de pagar?", "delivery", (a) => /e-mail/.test(a) && /link seguro/.test(a)]);
  cases.push([slug, "O que vem no conteúdo?", "content", (a) => a.startsWith(name + ":")]);
}
for (const [slug, q, intent, ok] of cases) {
  const r = answerSupportQuestion({ product: slug, question: q });
  if (r.answered && r.intent === intent && r.product === slug && ok(r.answer)) correct++;
  else failures.push(`${slug} / ${q} -> ${JSON.stringify(r)}`);
}

// Product resolved from free text, as a WhatsApp customer would write it.
const free = answerSupportQuestion({ question: "qual o valor do combo?" });
if (!(free.product === "combo-ia-vendas" && free.answer.includes("R$ 297,00"))) failures.push("free-text product resolution");
// Unknown questions must hand off, never invent.
const unknown = answerSupportQuestion({ product: "ia-na-pratica", question: "vocês fazem site para restaurante?" });
if (unknown.answered || !unknown.handoff) failures.push("unknown question must hand off");
// Price without product asks which product instead of guessing.
const ambiguous = answerSupportQuestion({ question: "quanto custa?" });
if (ambiguous.answered || !ambiguous.needs_product) failures.push("ambiguous price must ask for product");
// HTTP contract.
const res = handleSupportKnowledge(new Request("https://zevanory.api.br/api/support/knowledge?product=lucro-e-caixa&q=pre%C3%A7o"));
const body = await res.json();
if (res.status !== 200 || !body.answer?.includes("R$ 247,00") || res.headers.get("cache-control") !== "no-store") failures.push("http contract");
const post = handleSupportKnowledge(new Request("https://zevanory.api.br/api/support/knowledge", { method: "POST" }));
if (post.status !== 405) failures.push("POST must be 405");

const pct = (correct / cases.length) * 100;
console.log(`SUPPORT_KNOWLEDGE_CORPUS=${correct}/${cases.length} (${pct}%)`);
if (failures.length || pct < 100) {
  for (const f of failures) console.log("::error title=SUPPORT_KNOWLEDGE::" + f.slice(0, 400));
  process.exit(1);
}
console.log("SUPPORT_KNOWLEDGE=PASS");
