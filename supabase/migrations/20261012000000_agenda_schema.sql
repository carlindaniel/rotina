-- =====================================================================================
-- Minha Rotina — esquema do planejamento, execução e histórico (prefixo agenda_)
--
-- COMO USAR: Supabase → SQL Editor → cole TODO este arquivo → Run.
--  • Pode ser executado de novo sem erro (usa "if not exists", "or replace" e recria as políticas).
--  • NÃO altera nem recria as tabelas existentes rotina, exercicios e listas_area:
--    elas só são REFERENCIADAS (chave estrangeira) pelas tabelas novas.
--  • As tabelas rotina/exercicios precisam existir (id_rotina e id_exercicio são chaves primárias).
--
-- O QUE É CRIADO
--   agenda_motivos          motivos de não execução (lista compartilhada, com 5 motivos iniciais)
--   agenda_modelos          programações: modelos que repetem OU uma data específica (recorrencia = 'unica')
--   agenda_modelo_itens     atividades de cada programação (rotina, exercício ou atividade própria)
--   agenda_ocorrencias      cada atividade em cada dia, com cópia do que foi planejado (preserva o histórico)
--   agenda_google_contas    ligação com o Google Agenda (token fica FORA do alcance do navegador)
--   agenda_google_execucoes registro das sincronizações com o Google Agenda
--   funções agenda_*        cálculo de horários, geração de ocorrências, conflitos e manutenção
--
-- FUSO HORÁRIO: America/Sao_Paulo (função agenda_tz(); mude só ali se precisar).
-- =====================================================================================

-- ---------- constantes ----------
create or replace function public.agenda_tz() returns text
language sql immutable parallel safe set search_path = public as $$ select 'America/Sao_Paulo'::text $$;

-- Duração (s) de uma atividade própria sem duração informada. Mantenha igual a DURACAO_LIVRE_PADRAO_SEG em js/dados.js.
create or replace function public.agenda_duracao_livre_padrao() returns integer
language sql immutable parallel safe set search_path = public as $$ select 900 $$;

create or replace function public.agenda_hoje() returns date
language sql stable set search_path = public as $$ select (now() at time zone public.agenda_tz())::date $$;

-- ---------- motivos de não execução ----------
create table if not exists public.agenda_motivos (
  id         smallint generated always as identity primary key,
  descricao  text not null unique check (length(btrim(descricao)) > 0)
);
insert into public.agenda_motivos (descricao)
  values ('Sem tempo'), ('Cansaço'), ('Esqueci'), ('Imprevisto'), ('Mal-estar')
  on conflict (descricao) do nothing;

-- ---------- programações (modelos e datas específicas) ----------
create table if not exists public.agenda_modelos (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome             text not null check (length(btrim(nome)) > 0),
  recorrencia      text not null check (recorrencia in ('diaria', 'semanal', 'intervalo', 'unica')),
  dias_semana      smallint[] not null default '{}',          -- 1 = segunda ... 7 = domingo (usado em 'semanal')
  intervalo_dias   integer,                                   -- usado em 'intervalo': a cada N dias, contando de data_inicio
  data_inicio      date not null,
  data_fim         date,
  hora_inicio      time,                                      -- início da 1ª atividade (pode vir da hora_fixa do 1º item)
  lembrete_minutos integer check (lembrete_minutos between 0 and 1440),
  ativo            boolean not null default true,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  constraint agenda_modelos_datas check (data_fim is null or data_fim >= data_inicio),
  constraint agenda_modelos_semanal check (
    recorrencia <> 'semanal'
    or (cardinality(dias_semana) > 0 and dias_semana <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])),
  constraint agenda_modelos_intervalo check (
    (recorrencia = 'intervalo') = (intervalo_dias is not null)
    and (intervalo_dias is null or intervalo_dias between 1 and 365)),
  constraint agenda_modelos_unica check (
    recorrencia <> 'unica'
    or (data_fim = data_inicio and hora_inicio is not null and hora_inicio <> time '00:00'))
);
create index if not exists agenda_modelos_user_idx on public.agenda_modelos (user_id, ativo);

create table if not exists public.agenda_modelo_itens (
  id                        uuid primary key default gen_random_uuid(),
  modelo_id                 uuid not null references public.agenda_modelos (id) on delete cascade,
  posicao                   integer not null check (posicao >= 0),
  tipo                      text not null check (tipo in ('rotina', 'exercicio', 'livre')),
  id_rotina                 bigint references public.rotina (id_rotina) on delete set null,
  id_exercicio              bigint references public.exercicios (id_exercicio) on delete set null,
  titulo                    text,                              -- somente atividade própria ('livre')
  duracao_personalizada_seg integer check (duracao_personalizada_seg > 0),   -- vazio = duração do catálogo
  intervalo_antes_seg       integer not null default 0 check (intervalo_antes_seg >= 0),
  hora_fixa                 time,                              -- início próprio; vazio = logo após a anterior
  constraint agenda_itens_posicao_uq unique (modelo_id, posicao) deferrable initially deferred,
  constraint agenda_itens_origem check (
    (tipo = 'rotina'    and id_exercicio is null and titulo is null)
    or (tipo = 'exercicio' and id_rotina is null and titulo is null)
    or (tipo = 'livre'  and id_rotina is null and id_exercicio is null and length(btrim(coalesce(titulo, ''))) > 0))
);

-- ---------- ocorrências (cada atividade em cada dia) ----------
create table if not exists public.agenda_ocorrencias (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  modelo_id               uuid references public.agenda_modelos (id) on delete set null,
  modelo_item_id          uuid references public.agenda_modelo_itens (id) on delete set null,
  tipo                    text not null check (tipo in ('rotina', 'exercicio', 'livre')),
  id_rotina               bigint references public.rotina (id_rotina) on delete set null,
  id_exercicio            bigint references public.exercicios (id_exercicio) on delete set null,
  -- cópia do planejado: não muda se o catálogo ou o modelo mudarem depois
  titulo_planejado        text not null,
  categoria_planejada     text,
  area_planejada          text,
  data                    date not null,
  inicio_planejado        timestamptz not null,
  duracao_planejada_seg   integer not null check (duracao_planejada_seg > 0),
  fim_planejado           timestamptz not null,               -- calculado por trigger
  lembrete_minutos        integer,
  -- execução
  status                  text not null default 'agendada'
                          check (status in ('agendada', 'em_andamento', 'concluida', 'nao_realizada', 'cancelada')),
  iniciado_em             timestamptz,
  concluido_em            timestamptz,
  duracao_real_seg        integer check (duracao_real_seg >= 0),
  observacao              text,
  motivo_id               smallint references public.agenda_motivos (id) on delete set null,
  editada_manualmente     boolean not null default false,
  marcada_automaticamente boolean not null default false,
  -- Google Agenda
  gcal_event_id           text,
  gcal_sincronizado_em    timestamptz,
  criado_em               timestamptz not null default now(),
  atualizado_em           timestamptz not null default now()
);
-- impede duplicar a mesma atividade do modelo no mesmo dia ao gerar a programação de novo
create unique index if not exists agenda_ocorrencias_item_dia_uq
  on public.agenda_ocorrencias (modelo_item_id, data) where modelo_item_id is not null;
create index if not exists agenda_ocorrencias_user_data_idx on public.agenda_ocorrencias (user_id, data);
create index if not exists agenda_ocorrencias_modelo_idx on public.agenda_ocorrencias (modelo_id) where modelo_id is not null;
create index if not exists agenda_ocorrencias_status_data_idx on public.agenda_ocorrencias (status, data);

-- ---------- Google Agenda ----------
create table if not exists public.agenda_google_contas (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  google_email  text,
  refresh_token text not null,
  calendar_id   text not null,
  escopo        text,
  conectado_em  timestamptz not null default now(),
  ultimo_erro   text,
  ultimo_erro_em timestamptz
);
create table if not exists public.agenda_google_execucoes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  data_alvo   date not null,
  origem      text not null check (origem in ('agendado', 'manual')),
  criados     integer not null default 0,
  existentes  integer not null default 0,
  erros       integer not null default 0,
  detalhe     text,
  executado_em timestamptz not null default now()
);
create index if not exists agenda_google_execucoes_user_idx on public.agenda_google_execucoes (user_id, executado_em desc);

-- =====================================================================================
-- Regras de negócio (triggers)
-- =====================================================================================

create or replace function public.agenda_modelos_antes() returns trigger
language plpgsql set search_path = public as $$
begin
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists agenda_modelos_antes on public.agenda_modelos;
create trigger agenda_modelos_antes before update on public.agenda_modelos
  for each row execute function public.agenda_modelos_antes();

-- Fim planejado, estados de execução e marca de "ajustada manualmente".
create or replace function public.agenda_ocorrencias_regras() returns trigger
language plpgsql set search_path = public as $$
declare
  v_hoje date := public.agenda_hoje();
begin
  new.fim_planejado := new.inicio_planejado + new.duracao_planejada_seg * interval '1 second';
  new.atualizado_em := now();
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.inicio_planejado is distinct from old.inicio_planejado
     or new.duracao_planejada_seg is distinct from old.duracao_planejada_seg then
    new.editada_manualmente := true;   -- protege a ocorrência quando o modelo for reaplicado
  end if;

  if new.status is distinct from old.status then
    if not (case old.status
              when 'agendada'      then new.status in ('em_andamento', 'concluida', 'nao_realizada', 'cancelada')
              when 'em_andamento'  then new.status in ('agendada', 'concluida', 'nao_realizada')
              when 'concluida'     then new.status = 'agendada'
              when 'nao_realizada' then new.status in ('agendada', 'concluida')
              when 'cancelada'     then new.status = 'agendada'
              else false end) then
      raise exception 'Transição de status não permitida: % → %', old.status, new.status;
    end if;
    -- uma atividade futura não pode ser "não realizada"; e não se registra execução no futuro
    if new.status = 'nao_realizada' and new.data > v_hoje then
      raise exception 'Uma atividade futura não pode ser marcada como não realizada. Use “Cancelar”.';
    end if;
    if new.status in ('em_andamento', 'concluida') and new.data > v_hoje then
      raise exception 'Não é possível registrar execução em data futura.';
    end if;
    if new.status = 'concluida' and new.concluido_em is null then
      raise exception 'Informe o horário de conclusão.';
    end if;
    if new.status = 'agendada' then   -- desfazer: limpa o registro de execução
      new.iniciado_em := null;
      new.concluido_em := null;
      new.duracao_real_seg := null;
      new.motivo_id := null;
      new.marcada_automaticamente := false;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists agenda_ocorrencias_regras on public.agenda_ocorrencias;
create trigger agenda_ocorrencias_regras before insert or update on public.agenda_ocorrencias
  for each row execute function public.agenda_ocorrencias_regras();

-- =====================================================================================
-- Cálculo de horários
-- =====================================================================================

-- A programação vale neste dia? (mesma regra de horarios.js: valeNoDia)
create or replace function public.agenda_vale_no_dia(m public.agenda_modelos, d date) returns boolean
language sql immutable set search_path = public as $$
  select d >= m.data_inicio
     and (m.data_fim is null or d <= m.data_fim)
     and case m.recorrencia
           when 'diaria'    then true
           when 'semanal'   then extract(isodow from d)::smallint = any (m.dias_semana)
           when 'intervalo' then (d - m.data_inicio) % m.intervalo_dias = 0
           when 'unica'     then d = m.data_inicio
           else false
         end
$$;

-- Horários das atividades de uma programação, em segundos desde 00:00 (mesma regra de horarios.js: calcularSequencia):
--   duração = própria ou do catálogo; início = hora_fixa (se não anterior ao fim da atividade anterior) ou fim anterior + intervalo.
create or replace function public.agenda_sequencia(p_modelo uuid)
returns table (item_id uuid, posicao integer, tipo text, id_rotina bigint, id_exercicio bigint, titulo text,
               categoria text, area text, inicio_seg integer, fim_seg integer, duracao_seg integer, conflito boolean)
language plpgsql stable set search_path = public as $$
declare
  v_hora  time;
  v_cursor integer;
  v_inicio integer;
  v_fixa   integer;
  v_dur    integer;
  v_conf   boolean;
  it       record;
begin
  select m.hora_inicio into v_hora from agenda_modelos m where m.id = p_modelo;
  v_cursor := case when v_hora is null then null else extract(epoch from v_hora)::integer end;
  for it in
    select i.id as i_id, i.posicao as i_pos, i.tipo as i_tipo, i.id_rotina as i_rot, i.id_exercicio as i_exe, i.titulo as i_titulo,
           i.duracao_personalizada_seg as i_dur, i.intervalo_antes_seg as i_int, i.hora_fixa as i_fixa,
           r.titulo as r_titulo, r.duracao_segundos as r_dur,
           e.titulo as e_titulo, e.duracao_segundos as e_dur, la.nome as a_nome, la.categoria as a_cat
      from agenda_modelo_itens i
      left join rotina r on r.id_rotina = i.id_rotina
      left join exercicios e on e.id_exercicio = i.id_exercicio
      left join listas_area la on la.id_area = e.id_area
     where i.modelo_id = p_modelo
     order by i.posicao
  loop
    v_dur := coalesce(it.i_dur,
                      case it.i_tipo when 'rotina' then it.r_dur when 'exercicio' then it.e_dur
                                     else agenda_duracao_livre_padrao() end,
                      0);
    v_fixa := case when it.i_fixa is null then null else extract(epoch from it.i_fixa)::integer end;
    v_conf := false;
    if v_cursor is null then
      v_inicio := coalesce(v_fixa, 0);          -- sem início definido: o 1º item define
    else
      v_inicio := v_cursor + it.i_int;
      if v_fixa is not null then
        if v_fixa < v_inicio then v_conf := true; else v_inicio := v_fixa; end if;
      end if;
    end if;
    v_cursor := v_inicio + v_dur;
    item_id := it.i_id; posicao := it.i_pos; tipo := it.i_tipo; id_rotina := it.i_rot; id_exercicio := it.i_exe;
    titulo := coalesce(it.i_titulo, it.r_titulo, it.e_titulo, 'Atividade removida do catálogo');
    categoria := case it.i_tipo when 'rotina' then 'Rotina'
                                when 'exercicio' then coalesce(it.a_cat, 'Sem categoria')
                                else 'Personalizada' end;
    area := it.a_nome;
    inicio_seg := v_inicio; fim_seg := v_inicio + v_dur; duracao_seg := v_dur; conflito := v_conf;
    return next;
  end loop;
end $$;

-- =====================================================================================
-- Geração de ocorrências (idempotente: nunca duplica)
-- =====================================================================================

-- Gera as ocorrências de UM dia para as programações ativas (de todas, ou só de p_modelo). Devolve quantas criou.
-- Para quem chama pelo site, o RLS limita às programações da própria pessoa.
create or replace function public.agenda_gerar_dia(p_data date, p_modelo uuid default null) returns integer
language plpgsql set search_path = public as $$
declare
  m agenda_modelos;
  s record;
  v_n integer := 0;
  v_ins integer;
begin
  for m in select * from agenda_modelos x where x.ativo and (p_modelo is null or x.id = p_modelo) loop
    continue when not agenda_vale_no_dia(m, p_data);
    for s in select * from agenda_sequencia(m.id) loop
      continue when s.duracao_seg <= 0;
      insert into agenda_ocorrencias
        (user_id, modelo_id, modelo_item_id, tipo, id_rotina, id_exercicio, titulo_planejado, categoria_planejada,
         area_planejada, data, inicio_planejado, duracao_planejada_seg, fim_planejado, lembrete_minutos)
      values
        (m.user_id, m.id, s.item_id, s.tipo, s.id_rotina, s.id_exercicio, s.titulo, s.categoria, s.area, p_data,
         (p_data::timestamp + make_interval(secs => s.inicio_seg)) at time zone agenda_tz(),
         s.duracao_seg, now(), m.lembrete_minutos)   -- fim_planejado é recalculado pelo trigger
      on conflict (modelo_item_id, data) where modelo_item_id is not null do nothing;
      get diagnostics v_ins = row_count;
      v_n := v_n + v_ins;
    end loop;
  end loop;
  return v_n;
end $$;

-- Gera de hoje até hoje + p_dias.
create or replace function public.agenda_gerar_periodo(p_dias integer default 14, p_modelo uuid default null) returns integer
language plpgsql set search_path = public as $$
declare
  v_hoje date := agenda_hoje();
  d date;
  v_n integer := 0;
begin
  for d in select g::date from generate_series(v_hoje, v_hoje + p_dias, interval '1 day') g loop
    v_n := v_n + agenda_gerar_dia(d, p_modelo);
  end loop;
  return v_n;
end $$;

-- O que ficou agendado em dias anteriores vira "não realizada" (o prazo é o fim do dia). Devolve quantas.
create or replace function public.agenda_marcar_vencidas() returns integer
language plpgsql set search_path = public as $$
declare
  v_n integer;
begin
  update agenda_ocorrencias set status = 'nao_realizada', marcada_automaticamente = true
   where status = 'agendada' and data < agenda_hoje();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Depois de alterar uma programação: recria só o futuro ainda não iniciado e não ajustado à mão.
create or replace function public.agenda_reaplicar_modelo(p_modelo uuid) returns void
language plpgsql set search_path = public as $$
begin
  delete from agenda_ocorrencias
   where modelo_id = p_modelo and status = 'agendada' and not editada_manualmente
     and data >= agenda_hoje() and inicio_planejado > now();
  perform agenda_gerar_periodo(14, p_modelo);
end $$;

-- =====================================================================================
-- Conflitos de horário (sobreposição entre programações ativas e atividades avulsas)
-- =====================================================================================

-- Sobreposições de uma programação com as demais da mesma pessoa (e com atividades avulsas) nos próximos p_janela dias.
-- Terminar exatamente quando outra começa NÃO é conflito. Atividades que passam da meia-noite são comparadas com o dia seguinte.
create or replace function public.agenda_conflitos_modelo(p_modelo uuid, p_janela integer default 730)
returns table (data date, a_titulo text, a_inicio timestamptz, a_fim timestamptz,
               b_titulo text, b_origem text, b_avulsa boolean, b_inicio timestamptz, b_fim timestamptz)
language plpgsql stable set search_path = public as $$
declare
  m agenda_modelos;
  v_hoje date := agenda_hoje();
  v_ini date;
  v_lim date;
begin
  select * into m from agenda_modelos x where x.id = p_modelo;
  if not found or not m.ativo then return; end if;
  v_ini := greatest(m.data_inicio, v_hoje);
  v_lim := v_ini + p_janela;
  if m.data_fim is not null and m.data_fim < v_lim then v_lim := m.data_fim; end if;

  return query
  with meus as (
    select s.titulo, s.inicio_seg, s.fim_seg from agenda_sequencia(m.id) s where s.duracao_seg > 0
  ), dias as (
    select g::date as d from generate_series(v_ini, v_lim, interval '1 day') g where agenda_vale_no_dia(m, g::date)
  ), md as (
    select d.d, a.titulo, a.inicio_seg, a.fim_seg,
           (d.d::timestamp + make_interval(secs => a.inicio_seg)) at time zone agenda_tz() as t_ini,
           (d.d::timestamp + make_interval(secs => a.fim_seg))    at time zone agenda_tz() as t_fim
      from dias d cross join meus a
  ), seq_outros as (
    select o.id as oid, s.titulo, s.inicio_seg, s.fim_seg
      from agenda_modelos o cross join lateral agenda_sequencia(o.id) s
     where o.user_id = m.user_id and o.id <> m.id and o.ativo and s.duracao_seg > 0
  )
  select x.d, x.titulo, x.t_ini, x.t_fim, x.b_titulo, x.b_origem, x.b_avulsa, x.b_ini, x.b_fim
  from (
    select md.d, md.titulo, md.t_ini, md.t_fim, b.titulo as b_titulo, o.nome as b_origem, false as b_avulsa,
           ((md.d + k.k)::timestamp + make_interval(secs => b.inicio_seg)) at time zone agenda_tz() as b_ini,
           ((md.d + k.k)::timestamp + make_interval(secs => b.fim_seg))    at time zone agenda_tz() as b_fim
      from md
      cross join (values (-1), (0), (1)) k (k)
      join agenda_modelos o on o.user_id = m.user_id and o.id <> m.id and o.ativo and agenda_vale_no_dia(o, md.d + k.k)
      join seq_outros b on b.oid = o.id
     where md.inicio_seg < k.k * 86400 + b.fim_seg and k.k * 86400 + b.inicio_seg < md.fim_seg
    union all
    select md.d, md.titulo, md.t_ini, md.t_fim, oc.titulo_planejado, 'Avulsa', true, oc.inicio_planejado, oc.fim_planejado
      from md
      join agenda_ocorrencias oc
        on oc.user_id = m.user_id and oc.modelo_id is null and oc.status in ('agendada', 'em_andamento')
       and oc.data between md.d - 1 and md.d + 1
     where md.t_ini < oc.fim_planejado and oc.inicio_planejado < md.t_fim
  ) x
  order by x.d, x.t_ini, x.b_ini;
end $$;

-- =====================================================================================
-- Gravação das programações (uma única transação; recusa conflitos)
-- =====================================================================================

-- Cria ou atualiza uma programação com suas atividades, verifica conflitos e recalcula o futuro.
-- p_modelo = { id?, nome, recorrencia, dias_semana[], intervalo_dias, data_inicio, data_fim, hora_inicio, lembrete_minutos, ativo,
--              itens: [ { id?, tipo, id_origem?, titulo?, duracao_personalizada_seg?, intervalo_antes_seg?, hora_fixa? } ] }
create or replace function public.agenda_salvar_modelo(p_modelo jsonb) returns uuid
language plpgsql set search_path = public as $$
declare
  v_id     uuid := nullif(p_modelo ->> 'id', '')::uuid;
  v_rec    text := p_modelo ->> 'recorrencia';
  v_nome   text := btrim(coalesce(p_modelo ->> 'nome', ''));
  v_itens  jsonb := coalesce(p_modelo -> 'itens', '[]'::jsonb);
  v_ini    date := nullif(p_modelo ->> 'data_inicio', '')::date;
  v_fim    date := nullif(p_modelo ->> 'data_fim', '')::date;
  v_hora   time := nullif(p_modelo ->> 'hora_inicio', '')::time;
  v_dias   smallint[] := coalesce(array(select (jsonb_array_elements_text(coalesce(p_modelo -> 'dias_semana', '[]'::jsonb)))::smallint), '{}');
  v_intv   integer := nullif(p_modelo ->> 'intervalo_dias', '')::integer;
  v_lemb   integer := nullif(p_modelo ->> 'lembrete_minutos', '')::integer;
  v_ativo  boolean := coalesce((p_modelo ->> 'ativo')::boolean, true);
  v_ids    uuid[] := '{}';
  v_item   uuid;
  v_hora_fixa_1 time;
  it       record;
  j        jsonb;
  v_tipo   text;
  v_n      integer;
  c        record;
begin
  if v_rec is null or v_rec not in ('diaria', 'semanal', 'intervalo', 'unica') then
    raise exception 'Tipo de repetição inválido.';
  end if;
  if v_ini is null then
    raise exception '%', case when v_rec = 'unica' then 'Escolha a data.' else 'Informe a data inicial.' end;
  end if;
  if jsonb_array_length(v_itens) = 0 then
    raise exception 'Adicione ao menos uma atividade.';
  end if;
  if v_rec = 'unica' then
    if v_hora is null or v_hora = time '00:00' then
      raise exception 'Defina o horário de início da atividade (não pode ficar em branco nem 00:00).';
    end if;
    if v_ini < agenda_hoje() then
      raise exception 'Escolha uma data de hoje em diante.';
    end if;
    v_fim := v_ini;
    v_ativo := true;                       -- data específica não tem "ativo": existe ou é excluída
    if v_nome = '' then v_nome := 'Dia ' || to_char(v_ini, 'DD/MM/YYYY'); end if;
  else
    if v_nome = '' then raise exception 'Dê um nome ao modelo.'; end if;
    v_hora_fixa_1 := nullif(v_itens -> 0 ->> 'hora_fixa', '')::time;
    if v_hora is null and v_hora_fixa_1 is null then
      raise exception 'Defina o horário de início da sequência ou da 1ª atividade.';
    end if;
    if v_rec = 'semanal' and cardinality(v_dias) = 0 then raise exception 'Escolha ao menos um dia da semana.'; end if;
    if v_rec = 'intervalo' and (v_intv is null or v_intv < 1 or v_intv > 365) then
      raise exception 'Informe o intervalo em dias (de 1 a 365).';
    end if;
  end if;
  if v_fim is not null and v_fim < v_ini then raise exception 'A data final é anterior à inicial.'; end if;
  if v_rec <> 'intervalo' then v_intv := null; end if;

  if v_id is null then
    insert into agenda_modelos (nome, recorrencia, dias_semana, intervalo_dias, data_inicio, data_fim, hora_inicio, lembrete_minutos, ativo)
    values (v_nome, v_rec, v_dias, v_intv, v_ini, v_fim, v_hora, v_lemb, v_ativo)
    returning id into v_id;
  else
    update agenda_modelos
       set nome = v_nome, recorrencia = v_rec, dias_semana = v_dias, intervalo_dias = v_intv, data_inicio = v_ini,
           data_fim = v_fim, hora_inicio = v_hora, lembrete_minutos = v_lemb, ativo = v_ativo
     where id = v_id;
    if not found then raise exception 'Programação não encontrada.'; end if;
  end if;

  for it in select e.value as j, e.ordinality as ord from jsonb_array_elements(v_itens) with ordinality as e (value, ordinality) loop
    j := it.j;
    v_tipo := j ->> 'tipo';
    v_item := nullif(j ->> 'id', '')::uuid;
    if v_item is not null and exists (select 1 from agenda_modelo_itens x where x.id = v_item and x.modelo_id = v_id) then
      update agenda_modelo_itens
         set posicao = it.ord - 1, tipo = v_tipo,
             id_rotina = case when v_tipo = 'rotina' then nullif(j ->> 'id_origem', '')::bigint end,
             id_exercicio = case when v_tipo = 'exercicio' then nullif(j ->> 'id_origem', '')::bigint end,
             titulo = case when v_tipo = 'livre' then btrim(j ->> 'titulo') end,
             duracao_personalizada_seg = nullif(j ->> 'duracao_personalizada_seg', '')::integer,
             intervalo_antes_seg = coalesce(nullif(j ->> 'intervalo_antes_seg', '')::integer, 0),
             hora_fixa = nullif(j ->> 'hora_fixa', '')::time
       where id = v_item;
    else
      insert into agenda_modelo_itens (modelo_id, posicao, tipo, id_rotina, id_exercicio, titulo, duracao_personalizada_seg, intervalo_antes_seg, hora_fixa)
      values (v_id, it.ord - 1, v_tipo,
              case when v_tipo = 'rotina' then nullif(j ->> 'id_origem', '')::bigint end,
              case when v_tipo = 'exercicio' then nullif(j ->> 'id_origem', '')::bigint end,
              case when v_tipo = 'livre' then btrim(j ->> 'titulo') end,
              nullif(j ->> 'duracao_personalizada_seg', '')::integer,
              coalesce(nullif(j ->> 'intervalo_antes_seg', '')::integer, 0),
              nullif(j ->> 'hora_fixa', '')::time)
      returning id into v_item;
    end if;
    v_ids := v_ids || v_item;
  end loop;
  delete from agenda_modelo_itens where modelo_id = v_id and id <> all (v_ids);

  if v_ativo then   -- se houver conflito, a exceção desfaz TUDO que foi feito acima
    select count(*) into v_n from agenda_conflitos_modelo(v_id);
    if v_n > 0 then
      select * into c from agenda_conflitos_modelo(v_id) limit 1;
      raise exception 'AGENDA_CONFLITO: % sobreposição(ões) de horário. Primeira em %: «%» × «%» (%).',
        v_n, to_char(c.data, 'DD/MM/YYYY'), c.a_titulo, c.b_titulo, c.b_origem;
    end if;
  end if;

  perform agenda_reaplicar_modelo(v_id);
  return v_id;
end $$;

-- Ativa ou desativa uma programação (ativar também recusa conflitos).
create or replace function public.agenda_definir_ativo(p_modelo uuid, p_ativo boolean) returns void
language plpgsql set search_path = public as $$
declare
  v_n integer;
  c record;
begin
  update agenda_modelos set ativo = p_ativo where id = p_modelo;
  if not found then raise exception 'Programação não encontrada.'; end if;
  if p_ativo then
    select count(*) into v_n from agenda_conflitos_modelo(p_modelo);
    if v_n > 0 then
      select * into c from agenda_conflitos_modelo(p_modelo) limit 1;
      raise exception 'AGENDA_CONFLITO: % sobreposição(ões) de horário. Primeira em %: «%» × «%» (%).',
        v_n, to_char(c.data, 'DD/MM/YYYY'), c.a_titulo, c.b_titulo, c.b_origem;
    end if;
  end if;
  perform agenda_reaplicar_modelo(p_modelo);
end $$;

-- Exclui uma programação: remove só o futuro ainda não iniciado; o histórico (ocorrências) permanece.
create or replace function public.agenda_excluir_modelo(p_modelo uuid) returns void
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from agenda_modelos where id = p_modelo) then
    raise exception 'Programação não encontrada.';
  end if;
  delete from agenda_ocorrencias
   where modelo_id = p_modelo and status = 'agendada' and not editada_manualmente
     and data >= agenda_hoje() and inicio_planejado > now();
  delete from agenda_modelos where id = p_modelo;
end $$;

-- =====================================================================================
-- Google Agenda: situação da conexão (nunca expõe o token)
-- =====================================================================================
create or replace function public.agenda_google_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'conectado', exists (select 1 from agenda_google_contas c where c.user_id = auth.uid()),
    'email', (select c.google_email from agenda_google_contas c where c.user_id = auth.uid()),
    'calendar_id', (select c.calendar_id from agenda_google_contas c where c.user_id = auth.uid()),
    'ultimo_erro', (select c.ultimo_erro from agenda_google_contas c where c.user_id = auth.uid()),
    'ultima_execucao', (select to_jsonb(x) from (
        select e.data_alvo, e.origem, e.criados, e.existentes, e.erros, e.executado_em
          from agenda_google_execucoes e where e.user_id = auth.uid() order by e.executado_em desc limit 1) x))
$$;

-- =====================================================================================
-- Segurança: RLS (cada pessoa só vê e altera o que é seu) e permissões
-- =====================================================================================
alter table public.agenda_motivos          enable row level security;
alter table public.agenda_modelos          enable row level security;
alter table public.agenda_modelo_itens     enable row level security;
alter table public.agenda_ocorrencias      enable row level security;
alter table public.agenda_google_contas    enable row level security;   -- sem nenhuma política: só o servidor acessa
alter table public.agenda_google_execucoes enable row level security;

drop policy if exists agenda_motivos_select on public.agenda_motivos;
drop policy if exists agenda_motivos_insert on public.agenda_motivos;
create policy agenda_motivos_select on public.agenda_motivos for select to authenticated using (true);
create policy agenda_motivos_insert on public.agenda_motivos for insert to authenticated with check (true);

drop policy if exists agenda_modelos_dono on public.agenda_modelos;
create policy agenda_modelos_dono on public.agenda_modelos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists agenda_itens_dono on public.agenda_modelo_itens;
create policy agenda_itens_dono on public.agenda_modelo_itens for all to authenticated
  using (exists (select 1 from public.agenda_modelos m where m.id = modelo_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.agenda_modelos m where m.id = modelo_id and m.user_id = (select auth.uid())));

drop policy if exists agenda_ocorrencias_dono on public.agenda_ocorrencias;
create policy agenda_ocorrencias_dono on public.agenda_ocorrencias for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists agenda_google_execucoes_select on public.agenda_google_execucoes;
create policy agenda_google_execucoes_select on public.agenda_google_execucoes for select to authenticated
  using (user_id = (select auth.uid()));

-- Nada disso fica acessível para a chave pública sem login (anon).
revoke all on public.agenda_motivos, public.agenda_modelos, public.agenda_modelo_itens, public.agenda_ocorrencias,
              public.agenda_google_contas, public.agenda_google_execucoes from anon, authenticated;
grant select, insert on public.agenda_motivos to authenticated;
grant select, insert, update, delete on public.agenda_modelos, public.agenda_modelo_itens, public.agenda_ocorrencias to authenticated;
grant select on public.agenda_google_execucoes to authenticated;
-- agenda_google_contas: nenhuma permissão para anon/authenticated (guarda o refresh token do Google).

-- Funções: só pessoas logadas (e o servidor) podem executar.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'agenda\_%' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', r.f);
    execute format('grant execute on function %s to authenticated, service_role', r.f);
  end loop;
end $$;
