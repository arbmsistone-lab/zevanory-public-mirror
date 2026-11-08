-- ZEVANORY | P18 segunda via: desliga o monitor (reversão). Mantém o histórico (incidentes, alertas, tempos medidos).
-- Para apagar tudo depois: drop schema p18sv cascade; (e, no Vault, apagar o segredo p18sv_resend_api_key).
select cron.unschedule('p18sv-tick') where exists (select 1 from cron.job where jobname = 'p18sv-tick');
update p18sv.config set enabled = false, drill_until = null, updated_at = now() where id = 1;
