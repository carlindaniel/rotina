-- =====================================================================================
-- Minha Rotina — Google Agenda: eventos de datas específicas do mesmo dia (na hora) sem duplicar
--
-- EXECUTE depois de 20261013000000_agenda_google_conclusao.sql. Pode ser executado de novo sem erro.
--
-- PROBLEMA QUE ESTA MIGRAÇÃO RESOLVE
--   Ao salvar de novo uma programação, o banco apaga e recria as atividades futuras (com ids novos).
--   Se a atividade antiga já tinha um evento no Google, esse evento ficaria ÓRFÃO (sem registro que aponte para ele)
--   e um novo seria criado ao lado = duplicado. Agora, sempre que uma atividade com evento no Google é apagada,
--   o evento entra numa fila de exclusão, processada pela função do Google (antes de criar o novo).
-- =====================================================================================

create table if not exists public.agenda_google_exclusoes (
  id        bigint generated always as identity primary key,
  user_id   uuid not null,          -- sem FK de propósito: deve funcionar também quando a conta inteira é apagada
  event_id  text not null,
  criado_em timestamptz not null default now()
);
create index if not exists agenda_google_exclusoes_user_idx on public.agenda_google_exclusoes (user_id);

-- sem nenhuma política: somente o servidor lê e grava (a função do Google usa a chave de serviço)
alter table public.agenda_google_exclusoes enable row level security;
revoke all on public.agenda_google_exclusoes from anon, authenticated;

-- Atividade com evento no Google sendo apagada => registra o evento para ser excluído do Google.
-- SECURITY DEFINER: quem apaga pelo site não tem (nem deve ter) acesso à fila.
create or replace function public.agenda_ocorrencias_guardar_evento() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.gcal_event_id is not null and old.gcal_removido_em is null then
    insert into agenda_google_exclusoes (user_id, event_id) values (old.user_id, old.gcal_event_id);
  end if;
  return old;
end $$;
revoke all on function public.agenda_ocorrencias_guardar_evento() from public, anon, authenticated;

drop trigger if exists agenda_ocorrencias_guardar_evento on public.agenda_ocorrencias;
create trigger agenda_ocorrencias_guardar_evento before delete on public.agenda_ocorrencias
  for each row execute function public.agenda_ocorrencias_guardar_evento();
