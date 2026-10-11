-- =====================================================================================
-- Minha Rotina — agendamentos automáticos (pg_cron) para funcionar com o site fechado
--
-- EXECUTE SOMENTE DEPOIS de:
--   1) rodar 20261012000000_agenda_schema.sql;
--   2) publicar a função google-agenda (veja docs/CONFIGURACAO.md);
--   3) criar os dois segredos no Vault (comandos no passo 5 de docs/CONFIGURACAO.md).
--
-- AGENDAMENTOS (pg_cron usa UTC; o Brasil não tem horário de verão, então 23:00 em Brasília = 02:00 UTC):
--   agenda-google-2300       todos os dias às 23:00 (Brasília): gera as ocorrências de AMANHÃ e
--                            chama a função que cria os eventos de amanhã no Google Agenda.
--   agenda-manutencao-0005   todos os dias às 00:05 (Brasília): marca como "não realizada" o que ficou
--                            sem registro no dia anterior e gera as ocorrências dos próximos 14 dias.
-- =====================================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 23:00: garante as ocorrências de amanhã e aciona a criação dos eventos no Google Agenda.
-- Só cria para o PRÓXIMO dia em relação à data atual (a própria função do Google também calcula "amanhã").
create or replace function public.agenda_cron_google() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_amanha  date := public.agenda_hoje() + 1;
  v_url     text;
  v_segredo text;
begin
  perform public.agenda_gerar_dia(v_amanha);   -- o site pode estar fechado: o banco gera sozinho

  select ds.decrypted_secret into v_url     from vault.decrypted_secrets ds where ds.name = 'agenda_function_url';
  select ds.decrypted_secret into v_segredo from vault.decrypted_secrets ds where ds.name = 'agenda_cron_secret';
  if v_url is null or v_segredo is null then
    raise warning 'agenda_cron_google: crie os segredos agenda_function_url e agenda_cron_secret no Vault (docs/CONFIGURACAO.md)';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_segredo),
    body := jsonb_build_object('origem', 'agendado'),
    timeout_milliseconds := 60000);
end $$;

-- 00:05: manutenção diária.
create or replace function public.agenda_cron_manutencao() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.agenda_marcar_vencidas();
  perform public.agenda_gerar_periodo(14);
end $$;

-- só o próprio agendador executa estas funções
revoke all on function public.agenda_cron_google() from public, anon, authenticated;
revoke all on function public.agenda_cron_manutencao() from public, anon, authenticated;

-- (cron.schedule com o mesmo nome substitui o agendamento anterior: pode rodar de novo sem duplicar)
select cron.schedule('agenda-google-2300',     '0 2 * * *', $$select public.agenda_cron_google()$$);
select cron.schedule('agenda-manutencao-0005', '5 3 * * *', $$select public.agenda_cron_manutencao()$$);

-- Para conferir:        select jobid, jobname, schedule, active from cron.job where jobname like 'agenda-%';
-- Últimas execuções:    select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- Para desligar:        select cron.unschedule('agenda-google-2300');
