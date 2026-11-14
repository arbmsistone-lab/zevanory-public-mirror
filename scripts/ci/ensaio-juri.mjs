// Ensaio por PR — fase JÚRI (código do gh-pages; recebe GEMINI_API_KEY numa máquina que nunca executou código do PR).
// Os quadros e o pedido vêm do job de render (código do PR) como DADOS: PNG 540x960 conferido pelo cabeçalho,
// JSON com tamanho limitado; quadros do júri em 540x960 (como o render os envia ao Gemini). O avaliador é o do gh-pages. Saída: decisão e notas reais no log e em resultado.json.
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {avaliar} from '../criativos/avaliador.mjs';
export const QUADROS_MAX = 20, PNG_MAX_BYTES = 4e6, PEDIDO_MAX_BYTES = 512000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function lerQuadro(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.length > PNG_MAX_BYTES || !buf.subarray(0, 8).equals(PNG) || buf.toString('latin1', 12, 16) !== 'IHDR') throw Error('ensaio_quadro_invalido');
  if (buf.readUInt32BE(16) !== 540 || buf.readUInt32BE(20) !== 960) throw Error('ensaio_quadro_dimensao');
  return buf;
}
export function validarPedidoJuri(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.quadros) || !p.quadros.length || p.quadros.length > QUADROS_MAX) throw Error('ensaio_juri_pedido_invalido');
  if (p.quadros.some(n => typeof n !== 'string' || !/^juri-\d{1,2}\.png$/.test(n))) throw Error('ensaio_juri_nome_invalido');
  for (const k of ['criativo', 'padrao', 'medicao', 'permitidos']) if (!p[k] || typeof p[k] !== 'object') throw Error('ensaio_juri_campo:' + k);
  if (!Array.isArray(p.audio)) throw Error('ensaio_juri_campo:audio');
  return p;
}
export async function julgar({dir, key, avaliarImpl = avaliar}) {
  if (!key) throw Error('ensaio_sem_chave');
  const arq = join(dir, 'juri-pedido.json'); if (statSync(arq).size > PEDIDO_MAX_BYTES) throw Error('ensaio_juri_pedido_grande');
  const p = validarPedidoJuri(JSON.parse(readFileSync(arq, 'utf8')));
  const quadrosPng = p.quadros.map(n => lerQuadro(readFileSync(join(dir, n))));
  const av = await avaliarImpl({criativo: p.criativo, padrao: p.padrao, quadrosPng, medicao: p.medicao, permitidos: p.permitidos, oficial: p.oficial ?? null, key});
  const audio = p.audio.filter(x => typeof x === 'string').map(x => 'audio:' + x.replace(/[^\w-]/g, ''));
  if (audio.length) { av.aprovado = false; av.decisao = 'DESCARTADO'; av.motivos = [...audio, ...(av.motivos || [])]; }
  writeFileSync(join(dir, 'resultado.json'), JSON.stringify(av, null, 2));
  return av;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  julgar({dir: process.argv[2], key: process.env.GEMINI_API_KEY}).then(av => {
    console.log(`CRIATIVO_ENSAIO decisao=${av.decisao} nota_geral=${av.nota_geral ?? 'n/d'} notas=${av.juri ? JSON.stringify(av.juri.notas) : 'n/d'} motivos=${(av.motivos || []).join(',') || '-'}${av.erro ? ' erro=' + av.erro : ''}`);
    for (const x of av.juri?.problemas || []) console.log('PROBLEMA ' + x);
    for (const x of av.juri?.melhorias || []) console.log('MELHORIA ' + x);
  }).catch(e => { console.log(`::error title=ENSAIO_JURI::${String(e.message || e).replace(/[^\w:.-]/g, '_').slice(0, 120)}`); process.exitCode = 1; });
}
