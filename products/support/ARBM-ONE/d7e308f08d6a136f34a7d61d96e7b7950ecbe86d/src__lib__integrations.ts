import { supabase } from "@/lib/supabase";

export type IntegrationAdapter = {
  adapter_key: string; nome: string; categoria: string; direcao: string;
  status: "operacional" | "degradado" | "fundacao" | "desativado";
  health_state: "saudavel" | "atencao" | "indisponivel" | "nao_configurado";
  config_required: boolean; last_check_at: string | null; last_success_at: string | null;
  last_error_code: string | null; atualizado_em: string;
};

export type IntegrationResumo = {
  pendentes: number; processando: number; falharam: number;
  dead_letter: number; mais_antigo_minutos: number;
};

const rpc = supabase.rpc.bind(supabase) as unknown as (nome: string, params?: Record<string, unknown>) => Promise<{data: unknown; error: {message?: string}|null}>;

export async function carregarIntegracoes() {
  const [a, r] = await Promise.all([rpc("integration_adapters_listar_v1", {}), rpc("integration_eventos_resumo_v1", {})]);
  if (a.error) throw new Error(a.error.message || "Falha ao listar integrações.");
  if (r.error) throw new Error(r.error.message || "Falha ao carregar fila de eventos.");
  const resumo = (Array.isArray(r.data) ? r.data[0] : r.data) as IntegrationResumo;
  return { adapters: (a.data ?? []) as IntegrationAdapter[], resumo };
}

export type IntegrationActivation = {
  adapter_key: string; nome: string; required_total: number; approved_total: number;
  rejected_total: number; pending_total: number; ready: boolean;
};

export type IntegrationRequirement = {
  requirement_key: string; titulo: string; obrigatorio: boolean; segredo: boolean;
  status: "pendente" | "aprovado" | "reprovado";
  evidence_code: string | null; verificado_em: string | null;
};

export async function carregarStatusAtivacao() {
  const { data, error } = await rpc("integration_adapter_activation_status_v1", {});
  if (error) throw new Error(error.message || "Falha ao carregar prontidão das integrações.");
  return (data ?? []) as IntegrationActivation[];
}

export async function carregarRequisitosIntegracao(adapterKey: string) {
  const { data, error } = await rpc("integration_adapter_requirements_listar_v1", { p_adapter_key: adapterKey });
  if (error) throw new Error(error.message || "Falha ao carregar requisitos da integração.");
  return (data ?? []) as IntegrationRequirement[];
}

export type IntegrationHealthScore = {
  total_adapters:number; operacionais:number; degradados:number; indisponiveis:number;
  nao_configurados:number; readiness_percent:number; fila_pendente:number;
  falhas_ativas:number; dead_letter:number; score:number;
};
export async function carregarHealthScoreIntegracoes() {
  const { data, error } = await rpc("integration_health_score_v2", {});
  if (error) throw new Error(error.message || "Falha ao carregar health score das integrações.");
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? { total_adapters:0, operacionais:0, degradados:0, indisponiveis:0, nao_configurados:0, readiness_percent:0, fila_pendente:0, falhas_ativas:0, dead_letter:0, score:0 }) as IntegrationHealthScore;
}

export type IntegrationAdapterTelemetry = { adapter_key:string; eventos_24h:number; sucesso_24h:number; falhas_24h:number; retries_24h:number; taxa_sucesso_percent:number; latencia_media_ms:number; latencia_p95_ms:number; freshness_minutos:number|null; ultimo_sucesso_em:string|null; estado_telemetria:string; };
export async function carregarTelemetriaIntegracoes(){ const {data,error}=await rpc("integration_adapter_telemetry_v3",{}); if(error) throw new Error(error.message||"Falha ao carregar telemetria das integrações."); return (data??[]) as IntegrationAdapterTelemetry[]; }

export type IntegrationEcosystemReadiness = {
  total_adapters: number; operational_adapters: number; configured_adapters: number;
  commerce_ready: number; conversation_ready: number; webhook_ready: number;
  coverage_percent: number; operational_percent: number;
};

export async function carregarReadinessEcossistema() {
  const { data, error } = await rpc("integration_ecosystem_readiness_v4", {});
  if (error) throw new Error(error.message || "Falha ao carregar prontidão do ecossistema.");
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? {
    total_adapters: 0, operational_adapters: 0, configured_adapters: 0,
    commerce_ready: 0, conversation_ready: 0, webhook_ready: 0,
    coverage_percent: 0, operational_percent: 0,
  }) as IntegrationEcosystemReadiness;
}
