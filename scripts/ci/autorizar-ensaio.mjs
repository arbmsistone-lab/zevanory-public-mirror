// NC-V34-05: autorização do ensaio pré-merge da prévia (shorts-v2-amostras.yml, sha_ensaio).
// Roda SEMPRE a partir do código do gh-pages (confiável), sem segredo, só com GITHUB_TOKEN de leitura. O SHA pedido
// só é aceito se, AGORA:
//  - tem 40 hex;
//  - é o HEAD exato de exatamente 1 PR ABERTO deste repositório (não fork), com base gh-pages;
//  - o PR tem a etiqueta owner-approved:<12 primeiros hex do SHA> (vínculo ao SHA: outro commit exige outra etiqueta);
//  - o último evento dessa etiqueta é "labeled" (não removida depois), feito pelo dono do repositório.
// Limite declarado: o executor (Claude) usa a mesma conta GitHub do proprietário, então a etiqueta sozinha não
// separa os dois. A autorização humana efetiva do ensaio é a aprovação do environment "ensaio-shorts" (revisor
// obrigatório = proprietário, "Review deployments" na interface), exigida pelo job que recebe o segredo. Esta
// verificação é a 1ª camada e roda de novo dentro do job protegido, depois da aprovação e antes do checkout.
export const RE_SHA = /^[0-9a-f]{40}$/;

export async function autorizarEnsaio({ sha, repo, token, fetchImpl = fetch }) {
  if (!RE_SHA.test(String(sha || ''))) throw Error('ensaio_sha_invalido');
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || '')) || !token) throw Error('ensaio_contexto_invalido');
  const get = async path => {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!r || r.status !== 200) throw Error('ensaio_github_ilegivel');
    return r.json();
  };
  const [dono] = repo.split('/');
  const prs = (await get(`/commits/${sha}/pulls?per_page=100`)).filter(p => p?.state === 'open' && p?.head?.sha === sha);
  if (prs.length !== 1) throw Error(`ensaio_sem_pr_unico:${prs.length}`);
  const pr = prs[0];
  if (pr.head?.repo?.full_name !== repo) throw Error('ensaio_pr_de_fork');
  if (pr.base?.ref !== 'gh-pages') throw Error('ensaio_base_invalida');
  // Relê o PR pelo número: o HEAD precisa continuar sendo o SHA pedido (corrida com push novo).
  const atual = await get(`/pulls/${pr.number}`);
  if (atual?.state !== 'open' || atual?.head?.sha !== sha) throw Error('ensaio_head_mudou');
  const etiqueta = `owner-approved:${sha.slice(0, 12)}`;
  if (!(atual.labels || []).some(l => l?.name === etiqueta)) throw Error('ensaio_sem_etiqueta_do_sha');
  const eventos = [];
  for (let page = 1; page <= 10; page++) {
    const ev = await get(`/issues/${pr.number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(ev)) throw Error('ensaio_github_ilegivel');
    eventos.push(...ev); if (ev.length < 100) break; if (page === 10) throw Error('ensaio_eventos_demais');
  }
  const daEtiqueta = eventos.filter(e => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === etiqueta);
  const ultimo = daEtiqueta.at(-1);
  if (!ultimo || ultimo.event !== 'labeled') throw Error('ensaio_etiqueta_removida');
  if (ultimo.actor?.login !== dono) throw Error('ensaio_etiqueta_sem_autoridade');
  return { ok: true, pr: pr.number, sha, etiqueta, rotulado_em: ultimo.created_at };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  autorizarEnsaio({ sha: process.env.SHA_ENSAIO, repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN })
    .then(r => { console.log(`ENSAIO_AUTORIZADO pr=#${r.pr} sha=${r.sha} etiqueta=${r.etiqueta} em=${r.rotulado_em}`); })
    .catch(e => { console.log(`::error title=ENSAIO_NAO_AUTORIZADO::${String(e.message || e).slice(0, 120)}`); process.exitCode = 1; });
}
