// P21 (docs/p21/tokens-por-worker.md): conteúdo "estacionado" do candidato FIXO zevanory-sales-candidate.
// Com cutover=true o token de vendas só tem Editor nos dois Workers de vendas e não pode APAGAR o candidato (Editor
// por Worker não cria nem apaga Workers: developers.cloudflare.com/workers/authorization/workers/). Para que o
// candidato não continue servindo a página de vendas em *.workers.dev depois do release, o fim do job publica este
// Worker inerte por cima: 410 sem conteúdo, fora de indexação. Sem bindings, sem segredos, sem rede.
export default {
  async fetch() {
    return new Response("candidato estacionado\n", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  },
};
