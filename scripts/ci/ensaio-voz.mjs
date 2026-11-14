// Ensaio por PR — fase VOZ (código do gh-pages, único lugar além do júri que recebe GEMINI_API_KEY).
// Lê o pedido gerado pelo código do PR em OUTRO job (dado, nunca código), valida e chama o TTS gratuito com a voz e o
// modelo FIXOS do gh-pages. O código do PR nunca roda numa máquina que tenha a chave.
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tts} from '../shorts-v2/render.mjs';
import {STYLE} from '../shorts-v2/core.mjs';
export const TEXTO_MAX = 2000, PEDIDO_MAX_BYTES = 20000;
export const RE_TEXTO = /^[\p{L}\p{N} .,:;!?$%&()'"\-–—/+]+$/u;
export function validarPedidoVoz(pedido, config) {
  if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) throw Error('ensaio_pedido_invalido');
  const {texto, voz, modelo} = pedido;
  if (typeof texto !== 'string' || !texto.trim() || texto.length > TEXTO_MAX || !RE_TEXTO.test(texto)) throw Error('ensaio_texto_invalido');
  if (voz !== config.voz_fixa) throw Error('ensaio_voz_diferente_da_fixa');
  if (modelo !== config.modelo) throw Error('ensaio_modelo_diferente_do_fixo');
  return {texto, voz, modelo};
}
export async function gerarVoz({pedidoPath, outDir, key, freeTier, config, ttsImpl = tts}) {
  if (!key) throw Error('ensaio_sem_chave');
  if (freeTier !== 'true') throw Error('ensaio_nivel_gratuito_nao_confirmado');
  if (statSync(pedidoPath).size > PEDIDO_MAX_BYTES) throw Error('ensaio_pedido_grande_demais');
  const p = validarPedidoVoz(JSON.parse(readFileSync(pedidoPath, 'utf8')), config);
  const r = await ttsImpl(p.texto, p.voz, key, {model: p.modelo, freeTierConfirmed: true, style: STYLE});
  if (!Buffer.isBuffer(r?.pcm) || !r.pcm.length || r.voice !== p.voz || r.model !== p.modelo) throw Error('ensaio_voz_invalida');
  mkdirSync(outDir, {recursive: true});
  writeFileSync(join(outDir, 'voz.pcm'), r.pcm);
  const meta = {voice: r.voice, model: r.model, texto_sha256: createHash('sha256').update(p.texto).digest('hex'), bytes: r.pcm.length};
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta));
  return meta;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(readFileSync(new URL('../../data/shorts-padrao-v2.json', import.meta.url), 'utf8'));
  gerarVoz({pedidoPath: process.argv[2], outDir: process.argv[3], key: process.env.GEMINI_API_KEY, freeTier: process.env.FREE_TIER_CONFIRMED, config})
    .then(m => console.log(`ENSAIO_VOZ ok voz=${m.voice} modelo=${m.model} bytes=${m.bytes} texto_sha256=${m.texto_sha256}`))
    .catch(e => { console.log(`::error title=ENSAIO_VOZ::${String(e.geminiCode || e.message || e).replace(/[^\w:.-]/g, '_').slice(0, 120)}`); process.exitCode = 1; });
}
