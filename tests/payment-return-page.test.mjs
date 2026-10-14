import test from "node:test";
import assert from "node:assert/strict";
import worker,{paymentReturnPage} from "../worker/sales-public-worker.mjs";

const assets={fetch:async()=>new Response("<html>solucoes</html>",{status:200,headers:{"content-type":"text/html"}})};
const env={ASSETS:assets};
const get=path=>worker.fetch(new Request("https://vendas.zevanory.api.br"+path,{headers:{"user-agent":"bot test"}}),env,{waitUntil(){}});

test("each Mercado Pago back_url state gets an honest, non-indexed page",async()=>{
  for(const state of ["aprovado","pendente","falhou"]){
    const r=await get("/solucoes?pagamento="+state);
    assert.equal(r.status,200,state);
    assert.equal(r.headers.get("x-robots-tag"),"noindex");
    assert.equal(r.headers.get("cache-control"),"no-store");
    const html=await r.text();
    // The redirect is not proof of payment: never claim confirmation or that nothing was charged.
    assert.doesNotMatch(html,/pagamento (foi )?confirmado|compra confirmada|nada foi cobrado|não foi cobrad/i,state);
    assert.match(html,/wa\.me\/5588992545413|entrega\/reenviar/,state);
    // The return URL is typed by anyone: no page may attribute a result to the provider.
    assert.doesNotMatch(html,/Mercado Pago (informou|confirmou|recusou)|pagamento (foi )?(recusado|negado)|não foi (finalizado|concluído)|pagamento em análise/i,state);
  }
  assert.match(await (await get("/solucoes/?pagamento=aprovado")).text(),/entrega\/reenviar/);
});

test("unknown or absent state falls back to the normal solutions page",async()=>{
  for(const p of ["/solucoes","/solucoes?pagamento=","/solucoes?pagamento=<script>","/solucoes?pagamento=constructor","/solucoes?pagamento=__proto__"]){
    const r=await get(p);
    assert.equal(await r.text(),"<html>solucoes</html>",p);
  }
  assert.equal(paymentReturnPage("toString"),null);
});

test("failure return never asserts the outcome and points to checking status before retrying",async()=>{
  const html=await (await get("/solucoes?pagamento=falhou")).text();
  assert.match(html,/não confirma/);
  assert.match(html,/Confira o status/);
  assert.match(html,/pagar duas vezes/);
  assert.match(html,/entrega\/reenviar/);
});
