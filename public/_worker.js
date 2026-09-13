const EDGE_ORIGIN='https://edge.zevanory.api.br';

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
      const target=new URL(url.pathname+url.search,EDGE_ORIGIN);
      const headers=new Headers(request.headers);
      headers.set('x-zevanory-static-failover','cloudflare-pages');
      return fetch(new Request(target.toString(),{
        method:request.method,
        headers,
        body:['GET','HEAD'].includes(request.method)?undefined:request.body,
        redirect:'manual'
      }));
    }
    return env.ASSETS.fetch(request);
  }
};
