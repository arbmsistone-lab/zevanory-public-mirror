import { supabase } from "@/lib/supabase";

export type CoreModulo = {
  modulo_key: string;
  nome: string;
  descricao: string;
  habilitado: boolean;
  disponivel_para_ativacao: boolean;
  obrigatorio: boolean;
  versao: string;
  atualizado_em: string;
};

export async function listarModulos(): Promise<CoreModulo[]> {
  const { data, error } = await supabase.rpc("core_modulos_listar_v1");
  if (error) throw new Error(error.message || "Falha ao carregar modulos.");
  return (data ?? []) as CoreModulo[];
}

export async function configurarModulo(moduloKey: string, habilitado: boolean, motivo: string) {
  const { data, error } = await supabase.rpc("core_modulo_configurar_v1", {
    p_modulo_key: moduloKey,
    p_habilitado: habilitado,
    p_motivo: motivo,
  });
  if (error) throw new Error(error.message || "Falha ao configurar modulo.");
  return data?.[0] ?? null;
}

export async function moduloHabilitado(moduloKey: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("core_modulo_habilitado_v1", { p_modulo_key: moduloKey });
  if (error) return false;
  return data === true;
}
