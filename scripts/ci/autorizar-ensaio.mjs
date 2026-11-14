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
// Modo PR (ordem do proprietário 14/11 18:10; contra-auditoria GPT-6 do #1055): só no workflow shorts-ensaio-pr.yml.
// A etiqueta ensaio-autorizado-pr, aplicada pelo dono, autoriza o HEAD ATUAL do PR (SHA exato, relido agora) por
// VALIDADE_PR_H horas, com no máximo MAX_ENSAIOS_24H execuções DAQUELE workflow em 24 h (total_count da API, que
// inclui a execução corrente; resposta incompleta = recusa) e só se o environment ensaio-shorts-pr existir restrito
// ao ramo gh-pages. A chave do Gemini NUNCA fica num job que executa código do PR (ver o workflow).
// O workflow antigo (shorts-v2-amostras.yml) continua só no modo SHA, como antes.
export const RE_SHA = /^[0-9a-f]{40}$/;
export const ETIQUETA_PR = 'ensaio-autorizado-pr', VALIDADE_PR_H = 24, MAX_ENSAIOS_24H = 8, ENV_PR = 'ensaio-shorts-pr', WORKFLOW_PR = 'shorts-ensaio-pr.yml';

export async function autorizarEnsaio({ sha, repo, token, fetchImpl = fetch, agora = Date.now(), modo = 'sha' }) {
  if (!['sha', 'pr'].includes(modo)) throw Error('ensaio_modo_invalido');
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
  if (modo === 'sha') {
    if (!nomes.includes(etiqueta)) throw Error('ensaio_sem_etiqueta_do_sha');
    const u = valida(etiqueta); return { ok: true, modo: 'sha', pr: pr.number, sha, etiqueta, rotulado_em: u.created_at };
  }
  if (!nomes.includes(ETIQUETA_PR)) throw Error('ensaio_sem_etiqueta_pr');
  const u = valida(ETIQUETA_PR), em = Date.parse(u.created_at);
  if (!Number.isFinite(em) || em > agora + 60e3) throw Error('ensaio_etiqueta_data_invalida');
  if (agora - em > VALIDADE_PR_H * 3600e3) throw Error('ensaio_etiqueta_pr_expirada');
  if (atual.user?.login !== dono) throw Error('ensaio_pr_de_outro_autor');
  // environment do modo PR: precisa existir e aceitar SÓ o ramo gh-pages (senão a chave poderia ir a outro ramo)
  const env = await get(`/environments/${ENV_PR}`);
  if (env?.name !== ENV_PR || env?.deployment_branch_policy?.custom_branch_policies !== true || env?.deployment_branch_policy?.protected_branches !== false) throw Error('ensaio_environment_invalido');
  const pol = await get(`/environments/${ENV_PR}/deployment-branch-policies?per_page=100`);
  const ramos = (pol?.branch_policies || []).map(x => `${x?.type || 'branch'}:${x?.name}`);
  if (pol?.total_count !== 1 || ramos.length !== 1 || ramos[0] !== 'branch:gh-pages') throw Error('ensaio_environment_invalido');
  // limite: execuções DESTE workflow em 24 h, pelo total_count (inclui a corrente, enfileirada ou em andamento)
  const desde = new Date(agora - 24 * 3600e3).toISOString();
  const runs = await get(`/actions/workflows/${WORKFLOW_PR}/runs?created=>=${desde}&per_page=1`);
  if (!Number.isInteger(runs?.total_count) || runs.total_count < 1) throw Error('ensaio_contagem_ilegivel');
  if (runs.total_count > MAX_ENSAIOS_24H) throw Error(`ensaio_limite_diario:${runs.total_count}>${MAX_ENSAIOS_24H}`);
  return { ok: true, modo: 'pr', pr: pr.number, sha, etiqueta: ETIQUETA_PR, rotulado_em: u.created_at, execucoes_24h: runs.total_count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  autorizarEnsaio({ sha: process.env.SHA_ENSAIO, repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, modo: process.env.MODO_ENSAIO || 'sha' })
    .then(r => { console.log(`ENSAIO_AUTORIZADO modo=${r.modo} pr=#${r.pr} sha=${r.sha} etiqueta=${r.etiqueta} em=${r.rotulado_em}${r.execucoes_24h ? ' execucoes_24h=' + r.execucoes_24h : ''}`); })
    .catch(e => { console.log(`::error title=ENSAIO_NAO_AUTORIZADO::${String(e.message || e).slice(0, 120)}`); process.exitCode = 1; });
}
