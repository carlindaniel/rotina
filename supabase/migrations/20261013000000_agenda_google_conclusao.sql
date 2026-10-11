-- =====================================================================================
-- Minha Rotina — Google Agenda: marcar concluídas e excluir, no fim do dia, o que não foi concluído
--
-- EXECUTE depois de 20261012000000_agenda_schema.sql e 20261012000100_agenda_cron.sql.
-- Pode ser executado de novo sem erro.
--
-- COMPORTAMENTO
--   • Ao concluir uma atividade no site, o evento no Google Agenda ganha "✓" no título e fica cinza
--     (se a conclusão for desfeita, o evento volta ao normal).
--   • Todos os dias às 00:10 (Brasília), os eventos dos dias ANTERIORES que não foram concluídos são EXCLUÍDOS
--     do Google Agenda, para não ficarem como pendentes. Os concluídos permanecem como histórico.
--   • Nada disso apaga dados do site: o banco continua sendo o registro oficial.
-- =====================================================================================

-- controle do que já foi feito no Google (evita repetir chamadas e nunca recria evento apagado)
alter table public.agenda_ocorrencias add column if not exists gcal_concluido  boolean not null default false;   -- o evento no Google está marcado ✓
alter table public.agenda_ocorrencias add column if not exists gcal_removido_em timestamptz;                      -- o evento foi excluído do Google em
create index if not exists agenda_ocorrencias_gcal_idx on public.agenda_ocorrencias (user_id, data)
  where gcal_event_id is not null and gcal_removido_em is null;

-- registro das execuções passa a distinguir "criação" de "conclusão/limpeza"
alter table public.agenda_google_execucoes add column if not exists tipo text not null default 'criacao'
  check (tipo in ('criacao', 'conclusao_limpeza'));
alter table public.agenda_google_execucoes add column if not exists marcados  integer not null default 0;
alter table public.agenda_google_execucoes add column if not exists removidos integer not null default 0;

-- situação da conexão (agora com a última limpeza); nunca expõe o token
create or replace function public.agenda_google_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'conectado', exists (select 1 from agenda_google_contas c where c.user_id = auth.uid()),
    'email', (select c.google_email from agenda_google_contas c where c.user_id = auth.uid()),
    'calendar_id', (select c.calendar_id from agenda_google_contas c where c.user_id = auth.uid()),
    'ultimo_erro', (select c.ultimo_erro from agenda_google_contas c where c.user_id = auth.uid()),
    'ultima_execucao', (select to_jsonb(x) from (
        select e.data_alvo, e.origem, e.criados, e.existentes, e.erros, e.executado_em
          from agenda_google_execucoes e where e.user_id = auth.uid() and e.tipo = 'criacao'
         order by e.executado_em desc limit 1) x),
    'ultima_limpeza', (select to_jsonb(x) from (
        select e.origem, e.marcados, e.removidos, e.erros, e.executado_em
          from agenda_google_execucoes e where e.user_id = auth.uid() and e.tipo = 'conclusao_limpeza'
         order by e.executado_em desc limit 1) x))
$$;

-- 00:10 (Brasília): aciona a limpeza e a marcação de concluídas na função do Google.
-- Reaproveita os segredos do Vault já criados (a URL de /sync vira /reconciliar).
create or replace function public.agenda_cron_google_limpeza() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url     text;
  v_segredo text;
begin
  select ds.decrypted_secret into v_url     from vault.decrypted_secrets ds where ds.name = 'agenda_function_url';
  select ds.decrypted_secret into v_segredo from vault.decrypted_secrets ds where ds.name = 'agenda_cron_secret';
  if v_url is null or v_segredo is null then
    raise warning 'agenda_cron_google_limpeza: faltam os segredos agenda_function_url e agenda_cron_secret no Vault';
    return;
  end if;
  perform net.http_post(
    url := regexp_replace(v_url, '/sync/?$', '/reconciliar'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_segredo),
    body := jsonb_build_object('origem', 'agendado'),
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.agenda_cron_google_limpeza() from public, anon, authenticated;

-- 00:10 de Brasília = 03:10 UTC (depois da manutenção das 00:05, que fecha o dia anterior)
select cron.schedule('agenda-google-limpeza-0010', '10 3 * * *', $$select public.agenda_cron_google_limpeza()$$);

-- Para conferir:  select jobname, schedule, active from cron.job where jobname like 'agenda-%';
