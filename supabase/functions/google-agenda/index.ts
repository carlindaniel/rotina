// Edge Function google-agenda (Deno). Publicar com:  supabase functions deploy google-agenda --no-verify-jwt
// (--no-verify-jwt: o Google chama /callback sem login; as demais rotas validam o token ou o segredo do agendamento por conta própria.)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { tratar } from './roteador.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function ok(r: any): any {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

const db = {
  async usuarioDoToken(token: string) {
    const r = await admin.auth.getUser(token);
    return r.data && r.data.user ? { id: r.data.user.id } : null;
  },
  async obterConta(userId: string) {
    return ok(await admin.from('agenda_google_contas').select('*').eq('user_id', userId).maybeSingle());
  },
  async listarContas(userId?: string) {
    let q = admin.from('agenda_google_contas').select('user_id, refresh_token, calendar_id, google_email');
    if (userId) q = q.eq('user_id', userId);
    return ok(await q) || [];
  },
  async salvarConta(c: any) {
    ok(await admin.from('agenda_google_contas').upsert({ ...c, ultimo_erro: null, ultimo_erro_em: null, conectado_em: new Date().toISOString() }));
  },
  async removerConta(userId: string) {
    ok(await admin.from('agenda_google_contas').delete().eq('user_id', userId));
  },
  // só o que ainda está agendado e ainda não tem evento (atividades canceladas não vão para o Google)
  async listarOcorrencias(userId: string, data: string) {
    return ok(await admin.from('agenda_ocorrencias')
      .select('id, titulo_planejado, categoria_planejada, area_planejada, inicio_planejado, fim_planejado, lembrete_minutos')
      .eq('user_id', userId).eq('data', data).eq('status', 'agendada').is('gcal_event_id', null)
      .order('inicio_planejado')) || [];
  },
  async marcarCriada(id: string, eventId: string) {
    ok(await admin.from('agenda_ocorrencias').update({ gcal_event_id: eventId, gcal_sincronizado_em: new Date().toISOString() }).eq('id', id));
  },
  // eventos que já existem no Google e cujo estado (✓ ou não) está diferente do site
  async listarParaMarcar(userId: string) {
    const cols = 'id, titulo_planejado, categoria_planejada, area_planejada, inicio_planejado, fim_planejado, lembrete_minutos, status';
    const base = () => admin.from('agenda_ocorrencias').select(cols).eq('user_id', userId).not('gcal_event_id', 'is', null).is('gcal_removido_em', null);
    const concluidas = ok(await base().eq('status', 'concluida').eq('gcal_concluido', false)) || [];
    const desfeitas = ok(await base().neq('status', 'concluida').eq('gcal_concluido', true)) || [];
    return concluidas.concat(desfeitas);
  },
  // fim do dia: dias anteriores a hoje, ainda com evento no Google e não concluídos
  async listarParaExcluir(userId: string, hoje: string) {
    return ok(await admin.from('agenda_ocorrencias').select('id, titulo_planejado')
      .eq('user_id', userId).not('gcal_event_id', 'is', null).is('gcal_removido_em', null).lt('data', hoje).neq('status', 'concluida')) || [];
  },
  // fila de eventos a excluir (atividades apagadas no site)
  async listarExclusoes(userId: string) {
    return ok(await admin.from('agenda_google_exclusoes').select('id, event_id').eq('user_id', userId).order('id')) || [];
  },
  async removerExclusao(id: number) {
    ok(await admin.from('agenda_google_exclusoes').delete().eq('id', id));
  },
  // datas específicas de HOJE, ainda agendadas, que não terminaram e ainda não têm evento
  async listarOcorrenciasHoje(userId: string, data: string) {
    const r = ok(await admin.from('agenda_ocorrencias')
      .select('id, titulo_planejado, categoria_planejada, area_planejada, inicio_planejado, fim_planejado, lembrete_minutos, status, agenda_modelos!inner(recorrencia)')
      .eq('user_id', userId).eq('data', data).eq('status', 'agendada').is('gcal_event_id', null)
      .eq('agenda_modelos.recorrencia', 'unica').gt('fim_planejado', new Date().toISOString()).order('inicio_planejado')) || [];
    return r.map((x: any) => { const { agenda_modelos, ...resto } = x; return resto; });
  },
  async registrarMarcacao(id: string, concluido: boolean) {
    ok(await admin.from('agenda_ocorrencias').update({ gcal_concluido: concluido }).eq('id', id));
  },
  async registrarRemocao(id: string) {
    ok(await admin.from('agenda_ocorrencias').update({ gcal_removido_em: new Date().toISOString(), gcal_concluido: false }).eq('id', id));
  },
  async registrarExecucao(x: any) {
    ok(await admin.from('agenda_google_execucoes').insert(x));
  },
  async registrarErroConta(userId: string, mensagem: string | null) {
    ok(await admin.from('agenda_google_contas').update({ ultimo_erro: mensagem, ultimo_erro_em: mensagem ? new Date().toISOString() : null }).eq('user_id', userId));
  },
};

Deno.serve((req: Request) => tratar(req, {
  env: {
    GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET'),
    STATE_SECRET: Deno.env.get('STATE_SECRET'),
    CRON_SECRET: Deno.env.get('CRON_SECRET'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  },
  fetch: (...a: [any, any?]) => fetch(...a),
  db,
}));
