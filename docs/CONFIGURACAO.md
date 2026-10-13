# Configuração: banco (Supabase) e Google Agenda

Faça nesta ordem. Os passos 1 e 6 já deixam o site funcionando; os passos 2 a 5 ligam o Google Agenda.
Projeto Supabase: `ixrwnrwdsasuerjwidgj`

> **Já configurou tudo antes?** Para ativar as novidades, faça só o [passo 7](#7-concluídas-e-limpeza-do-fim-do-dia-atualização) (concluir no site e limpeza do fim do dia) e o [passo 8](#8-data-específica-do-mesmo-dia-na-hora-e-lembretes-atualização).

## 1. Criar as tabelas (obrigatório)

1. Supabase → **SQL Editor** → **New query**.
2. Cole **todo** o conteúdo de [`supabase/migrations/20261012000000_agenda_schema.sql`](../supabase/migrations/20261012000000_agenda_schema.sql) e clique em **Run**.
3. Confira: `select count(*) from agenda_motivos;` deve devolver `5`.
4. Execute também [`supabase/migrations/20261015000000_agenda_descricao.sql`](../supabase/migrations/20261015000000_agenda_descricao.sql) (campo **Descrição** das datas específicas, exibido no botão **Descrição** da Execução).
5. Execute também [`supabase/migrations/20261016000000_agenda_conflito_1min.sql`](../supabase/migrations/20261016000000_agenda_conflito_1min.sql) (atividades de até 1 min podem ficar no mesmo horário de qualquer outra).
6. Execute também [`supabase/migrations/20261017000000_agenda_sem_duplicadas.sql`](../supabase/migrations/20261017000000_agenda_sem_duplicadas.sql) (evita e remove atividades duplicadas no mesmo dia depois de editar uma programação).

Pode executar de novo sem problema. O script **não altera** `rotina`, `exercicios` nem `listas_area`: só as referencia.
Abra o `index.html` e entre: modelos, datas específicas, execução e histórico já passam a ser gravados no Supabase.

> Os modelos e execuções que você criou antes neste navegador **não foram migrados** (continuam guardados só no navegador).

## 2. Google Cloud (uma vez)

1. <https://console.cloud.google.com> → crie um projeto (ex.: "Minha Rotina").
2. **APIs e serviços → Biblioteca** → **Google Calendar API** → **Ativar**.
3. **Tela de permissão OAuth**: tipo **Externo**, nome "Minha Rotina", seu e-mail. Em **Escopos**, adicione `.../auth/calendar.app.created` (além de `openid` e `email`).
4. **Publique o app (status "Em produção").** Em "Testando" o Google expira a autorização em **7 dias** e a criação das 23:00 para de funcionar. Na primeira conexão aparecerá "app não verificado": **Avançado → continuar** (o app é seu).
5. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**. Em *URIs de redirecionamento autorizados* coloque exatamente:
   `https://ixrwnrwdsasuerjwidgj.supabase.co/functions/v1/google-agenda/callback`
6. Copie o **ID do cliente** e a **chave secreta do cliente**.

## 3. Publicar a função `google-agenda`

No PowerShell, na pasta do projeto. O login da CLI precisa ser da conta dona do projeto `ixrwnrwdsasuerjwidgj`.

```powershell
supabase login
supabase link --project-ref ixrwnrwdsasuerjwidgj

# dois valores aleatórios diferentes (anote o CRON_SECRET: ele é usado no passo 4)
$STATE = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$CRON  = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$CRON   # copie este valor

supabase secrets set GOOGLE_CLIENT_ID="<ID do cliente>" GOOGLE_CLIENT_SECRET="<chave secreta>" STATE_SECRET="$STATE" CRON_SECRET="$CRON"
supabase functions deploy google-agenda --no-verify-jwt
```

`--no-verify-jwt` é necessário porque o Google chama `/callback` sem login; as demais rotas validam o login ou o segredo do agendamento por conta própria.

## 4. Segredos do agendamento (SQL Editor)

```sql
select vault.create_secret('https://ixrwnrwdsasuerjwidgj.supabase.co/functions/v1/google-agenda/sync', 'agenda_function_url');
select vault.create_secret('<o mesmo CRON_SECRET do passo 3>', 'agenda_cron_secret');
```

## 5. Agendar (SQL Editor)

Cole e execute [`supabase/migrations/20261012000100_agenda_cron.sql`](../supabase/migrations/20261012000100_agenda_cron.sql).
Se reclamar de extensão: **Database → Extensions** → ative `pg_cron` e `pg_net` e rode de novo.

| Agendamento | Horário (Brasília) | O que faz |
|---|---|---|
| `agenda-google-2300` | todos os dias, **23:00** | gera as atividades de **amanhã** e cria os eventos de amanhã no Google Agenda |
| `agenda-manutencao-0005` | todos os dias, 00:05 | marca como "não realizada" o que ficou sem registro no dia anterior e gera os próximos 14 dias |
| `agenda-google-limpeza-0010` | todos os dias, 00:10 (passo 7) | marca ✓ o que foi concluído e **exclui do Google** os eventos de dias anteriores que não foram concluídos |

## 6. Conectar e testar

1. Site → **Painel** → cartão **Google Agenda** → **Conectar Google Agenda** → autorize.
2. Clique em **Criar agora os eventos de amanhã** para testar sem esperar as 23:00.
3. No Google Agenda, a agenda **"Rotina"** aparece em *Minhas agendas* (marque para exibir).

## 7. Concluídas e limpeza do fim do dia (atualização)

Duas coisas, nesta ordem:

1. **SQL Editor:** cole e execute [`supabase/migrations/20261013000000_agenda_google_conclusao.sql`](../supabase/migrations/20261013000000_agenda_google_conclusao.sql).
2. **Publique a função de novo** (ela ganhou a rota `/reconciliar`). Os segredos já gravados não mudam:
   ```powershell
   supabase functions deploy google-agenda --no-verify-jwt --project-ref ixrwnrwdsasuerjwidgj
   ```

Pronto: não há segredo novo. O agendamento `agenda-google-limpeza-0010` reaproveita os do passo 4.

## 8. Data específica do mesmo dia na hora e lembretes (atualização)

Mesmo caminho do passo 7, sem segredo novo:

1. **SQL Editor:** execute [`supabase/migrations/20261014000000_agenda_google_imediato.sql`](../supabase/migrations/20261014000000_agenda_google_imediato.sql).
2. **Publique a função de novo:**
   ```powershell
   supabase functions deploy google-agenda --no-verify-jwt --project-ref ixrwnrwdsasuerjwidgj
   ```

Depois, recarregue o site (Ctrl+F5).

## Regras da integração

- Os eventos são criados **só para o dia seguinte** à data atual (fuso de Brasília), uma vez por dia. O botão "criar agora" segue a mesma regra.
- **Data específica criada para o mesmo dia** (hoje) vai para o Google **na hora**, ao salvar. Isso vale só para datas específicas, e só se a atividade ainda não terminou; os modelos que repetem seguem a regra das 23:00 do dia anterior.
- **Lembretes:** todo evento avisa **no momento do evento** e, além disso, antes (os "N min antes" configurados, por padrão 5). Eventos já criados antes desta mudança mantêm os lembretes antigos.
- Ao **salvar de novo** ou **excluir** uma programação, os eventos antigos das atividades substituídas são **excluídos do Google** (o banco registra isso numa fila), para não ficarem eventos duplicados ou órfãos.
- Cada evento usa o título real, o horário e o lembrete configurado. O id do evento vem da ocorrência, então **criar de novo nunca duplica**.
- Atividades **canceladas** não vão para o Google.
- **Concluir no site marca no Google:** o evento ganha **✓ no título e fica cinza** (o Google Agenda não tem "status de concluído"). Se você desfizer a conclusão no site, o evento volta ao normal. Isso acontece na hora; se falhar (sem internet, por exemplo), é refeito na limpeza das 00:10.
- **Limpeza do fim do dia (00:10):** os eventos de dias **anteriores** que **não foram concluídos** são **excluídos** do Google Agenda para não ficarem como pendentes. Os concluídos permanecem (com ✓) como histórico. O site não perde nada: os registros continuam no banco e no Histórico.
- Concluir uma atividade **depois** que o evento já foi excluído (por exemplo, no dia seguinte) registra no site, mas **não recria** o evento no Google. Um evento que você apagou à mão no Google também não é recriado.
- **Criação só de amanhã:** mudanças de horário ou cancelamentos feitos depois da criação **não** atualizam o evento (a limpeza das 00:10 remove o que não foi concluído). Atividades criadas ou alteradas depois das 23:00 do dia anterior só entram se você usar "criar agora" antes do dia terminar.
- Se um evento falhar ao ser criado, ele **não** é reenviado nas noites seguintes (cada noite cuida só do dia seguinte). Use "criar agora" e veja o motivo no cartão do Painel. Falhas ao marcar ✓ ou excluir são tentadas de novo na noite seguinte.
- O banco continua sendo o registro oficial; o Google Agenda serve de lembrete e de marcação do que foi feito.

## Conferir e diagnosticar

**Os SQLs estão todos aplicados?** Rode no SQL Editor; o resultado deve ser `true` nas quatro linhas:

```sql
select 'schema (passo 1)'      as passo, to_regclass('public.agenda_ocorrencias') is not null as ok
union all select 'cron (passo 5)',        exists (select 1 from cron.job where jobname = 'agenda-google-2300')
union all select 'conclusão (passo 7)',   (select count(*) from information_schema.columns where table_schema = 'public'
                                            and table_name = 'agenda_google_execucoes' and column_name in ('tipo','marcados','removidos')) = 3
union all select 'imediato (passo 8)',    to_regclass('public.agenda_google_exclusoes') is not null;
```

Se algum der `false`, execute o arquivo correspondente da pasta `supabase/migrations`. Se a função criar o evento mas houver SQL pendente, o site avisa com o texto "Execute os arquivos SQL pendentes".

```sql
select jobname, schedule, active from cron.job where jobname like 'agenda-%';
select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
select * from agenda_google_execucoes order by executado_em desc limit 10;   -- o que foi criado em cada execução
select id, status_code, content from net._http_response order by created desc limit 5;   -- resposta da função às 23:00
```

Para mudar o horário: o `pg_cron` usa UTC. 23:00 de Brasília = `0 2 * * *` (o Brasil não tem horário de verão no momento).

## Segurança

- A chave do site (`js/config.js`) é a **pública** (`anon`): ela só enxerga o que o login e o RLS permitem. **Nunca** coloque a `service_role` no site.
- O token do Google fica na tabela `agenda_google_contas`, **sem permissão** para o navegador; só a função, no servidor, lê.
- Cada pessoa só vê e altera os próprios modelos e ocorrências (RLS). `rotina`, `exercicios` e `listas_area` continuam como estavam.
- Recomenda-se desligar o cadastro público em **Authentication → Sign In / Providers → Allow new users to sign up**.
