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
// Modo PR (ordem do proprietário 14/11 18:10: "uma única aprovação sua valha para as próximas rodadas do mesmo PR"):
// a etiqueta ensaio-autorizado-pr, aplicada pelo dono, autoriza o HEAD ATUAL daquele PR (cada rodada continua presa ao
// SHA exato, relido agora) por VALIDADE_PR_H horas desde a aplicação, com no máximo MAX_ENSAIOS_24H disparos do
// workflow nas últimas 24 h. Roda no environment ensaio-shorts-pr (só GEMINI_API_KEY gratuita, sem credencial de
// publicação). A etiqueta por SHA (owner-approved:<12hex>) continua valendo e tem precedência (environment com revisor).
export const RE_SHA = /^[0-9a-f]{40}$/;
export const ETIQUETA_PR = 'ensaio-autorizado-pr', VALIDADE_PR_H = 24, MAX_ENSAIOS_24H = 8;

export async function autorizarEnsaio({ sha, repo, token, fetchImpl = fetch, agora = Date.now(), workflow = 'shorts-v2-amostras.yml' }) {
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
  const eventos = [];
  for (let page = 1; page <= 10; page++) {
    const ev = await get(`/issues/${pr.number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(ev)) throw Error('ensaio_github_ilegivel');
    eventos.push(...ev); if (ev.length < 100) break; if (page === 10) throw Error('ensaio_eventos_demais');
  }
  // último evento labeled/unlabeled da etiqueta: precisa ser "labeled" e feito pelo dono do repositório
  const valida = nome => {
    const ultimo = eventos.filter(e => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === nome).at(-1);
    if (!ultimo || ultimo.event !== 'labeled') throw Error('ensaio_etiqueta_removida');
    if (ultimo.actor?.login !== dono) throw Error('ensaio_etiqueta_sem_autoridade');
    return ultimo;
  };
  const nomes = (atual.labels || []).map(l => l?.name), etiqueta = `owner-approved:${sha.slice(0, 12)}`;
  if (nomes.includes(etiqueta)) { const u = valida(etiqueta); return { ok: true, modo: 'sha', pr: pr.number, sha, etiqueta, rotulado_em: u.created_at }; }
  if (!nomes.includes(ETIQUETA_PR)) throw Error('ensaio_sem_etiqueta_do_sha');
  const u = valida(ETIQUETA_PR), em = Date.parse(u.created_at);
  if (!Number.isFinite(em) || em > agora + 60e3) throw Error('ensaio_etiqueta_data_invalida');
  if (agora - em > VALIDADE_PR_H * 3600e3) throw Error('ensaio_etiqueta_pr_expirada');
  if (atual.user?.login !== dono) throw Error('ensaio_pr_de_outro_autor');
  const desde = new Date(agora - 24 * 3600e3).toISOString();
  const runs = await get(`/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=>=${desde}&per_page=100`);
  if (!Array.isArray(runs?.workflow_runs)) throw Error('ensaio_github_ilegivel');
  if (runs.workflow_runs.length > MAX_ENSAIOS_24H) throw Error(`ensaio_limite_diario:${runs.workflow_runs.length}>${MAX_ENSAIOS_24H}`);
  return { ok: true, modo: 'pr', pr: pr.number, sha, etiqueta: ETIQUETA_PR, rotulado_em: u.created_at };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  autorizarEnsaio({ sha: process.env.SHA_ENSAIO, repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN })
    .then(async r => {
      // na reverificação (job protegido) o modo tem de ser o MESMO que escolheu o environment
      if (process.env.MODO_ESPERADO && process.env.MODO_ESPERADO !== r.modo) throw Error(`ensaio_modo_mudou:${process.env.MODO_ESPERADO}->${r.modo}`);
      if (process.env.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, `modo=${r.modo}\n`);
      console.log(`ENSAIO_AUTORIZADO modo=${r.modo} pr=#${r.pr} sha=${r.sha} etiqueta=${r.etiqueta} em=${r.rotulado_em}`);
    })
    .catch(e => { console.log(`::error title=ENSAIO_NAO_AUTORIZADO::${String(e.message || e).slice(0, 120)}`); process.exitCode = 1; });
}
