// B02 sandbox (sandbox-route-probe.yml): Worker vizinho descartável. Suas rotas são as que a mutação tripla
// "rouba" e que a restauração tem de devolver.
export default {
  async fetch() {
    return new Response("zevanory-route-neighbour\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
