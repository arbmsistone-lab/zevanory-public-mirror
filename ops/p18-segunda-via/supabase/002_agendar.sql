-- ZEVANORY | P18 segunda via: liga o monitor e agenda o ciclo de 1 minuto no pg_cron.
-- Rodar SÓ depois de 001 e de preencher o destinatário e a chave (docs/p18/segunda-via-supabase.md, passos 5 e 6).
-- Antes de ligar, confere que o canal de alerta está configurado (sem isso o monitor alertaria para ninguém).
do $$
begin
  if cardinality((select alert_to from p18sv.config where id = 1)) = 0 then
    raise exception 'P18SV_NOT_CONFIGURED: preencha alert_to (passo 5) antes de agendar';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = (select resend_secret_name from p18sv.config where id = 1)) then
    raise exception 'P18SV_NOT_CONFIGURED: crie o segredo do Resend no Vault (passo 6) antes de agendar';
  end if;
end $$;
update p18sv.config set enabled = true, updated_at = now() where id = 1;
select cron.schedule('p18sv-tick', '* * * * *', $cmd$select p18sv.tick()$cmd$);
