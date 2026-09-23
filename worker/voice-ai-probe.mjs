export default {
  async fetch(request, env) {
    try {
      const out = await env.AI.run("@cf/myshell-ai/melotts", {
        prompt: "Olá, aqui é o suporte da ZEVANORY. Como posso ajudar você hoje?",
        lang: "pt"
      });
      if (out instanceof Response) return out;
      if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
        return new Response(out, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
      }
      if (out && typeof out === "object") {
        const audio = out.audio || out.audio_base64 || out.data || null;
        if (typeof audio === "string") {
          const bin = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
          return new Response(bin, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
        }
      }
      return new Response(JSON.stringify({ error: "unexpected_output", type: typeof out, keys: out && typeof out === "object" ? Object.keys(out) : [] }), { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error?.message || error) }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  }
};
