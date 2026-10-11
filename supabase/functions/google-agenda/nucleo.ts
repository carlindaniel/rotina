/*
 * Núcleo da integração com o Google Agenda: funções sem dependências de ambiente (recebem `fetch` e acesso a dados por parâmetro),
 * para serem testadas fora do Supabase. Roda em Deno (Edge Function) e em Node.
 *
 * Regra de negócio: os eventos são criados SOMENTE para o dia seguinte à data atual (fuso America/Sao_Paulo),
 * uma vez por dia (agendamento das 23:00). O banco continua sendo a fonte da verdade; o Google Agenda é só lembrete.
 */

export const TZ = 'America/Sao_Paulo';
// calendar.app.created: cria uma agenda própria do aplicativo e gerencia só os eventos dela (não toca nas outras agendas).
export const ESCOPOS = 'openid email https://www.googleapis.com/auth/calendar.app.created';
export const NOME_AGENDA = 'Rotina';
export const COR_CONCLUIDA = '8';   // cinza (grafite) nas cores de evento do Google Agenda
export const MARCA_CONCLUIDA = '✓ ';

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

// ---------- datas ----------

/** 'AAAA-MM-DD' da data atual em America/Sao_Paulo. */
export function dataEmSaoPaulo(agora: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
  return p; // en-CA => AAAA-MM-DD
}

/** O PRÓXIMO dia em relação à data atual (aritmética de calendário, sem depender de fuso). */
export function amanhaEmSaoPaulo(agora: Date = new Date()): string {
  const [a, m, d] = dataEmSaoPaulo(agora).split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d + 1));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

// ---------- evento ----------

/** O Google aceita ids de 5 a 1024 caracteres em base32hex (a-v, 0-9): o UUID sem hífens serve e torna a criação idempotente. */
export function idEventoDeOcorrencia(uuid: string): string {
  return String(uuid).replace(/-/g, '').toLowerCase();
}

/** Lembretes do evento: o configurado (ex.: 5 min antes) e SEMPRE um no momento do evento (0 min). */
export function lembretes(antes: any): any[] {
  const minutos = new Set<number>([0]);
  if (antes != null && Number(antes) >= 0) minutos.add(Number(antes));
  return [...minutos].sort((a, b) => b - a).map((m) => ({ method: 'popup', minutes: m }));
}

export function montarEvento(oc: any): any {
  const concluida = oc.status === 'concluida';
  const detalhes = [oc.categoria_planejada, oc.area_planejada].filter(Boolean).join(' · ');
  const evento: any = {
    id: idEventoDeOcorrencia(oc.id),
    summary: (concluida ? MARCA_CONCLUIDA : '') + oc.titulo_planejado,   // título real; concluída ganha ✓
    description: (detalhes ? detalhes + '\n' : '') + (concluida ? 'Concluída\n' : '') + 'Criado por Minha Rotina',
    start: { dateTime: oc.inicio_planejado, timeZone: TZ },
    end: { dateTime: oc.fim_planejado, timeZone: TZ },
    reminders: { useDefault: false, overrides: lembretes(oc.lembrete_minutos) },
    extendedProperties: { private: { ocorrencia_id: oc.id, origem: 'minha-rotina' } },
  };
  if (concluida) evento.colorId = COR_CONCLUIDA;
  return evento;
}

// ---------- estado assinado do OAuth (impede forjar o retorno do Google) ----------

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(txt: string): Uint8Array {
  const s = atob(txt.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function hmac(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto))));
}
export async function assinarEstado(segredo: string, dados: any): Promise<string> {
  const corpo = b64url(new TextEncoder().encode(JSON.stringify(dados)));
  return corpo + '.' + await hmac(segredo, corpo);
}
export async function lerEstado(segredo: string, token: string, agora: number = Date.now()): Promise<any | null> {
  const [corpo, assinatura] = String(token || '').split('.');
  if (!corpo || !assinatura) return null;
  if (!iguais(await hmac(segredo, corpo), assinatura)) return null;
  try {
    const dados = JSON.parse(new TextDecoder().decode(deB64url(corpo)));
    return dados && dados.exp > agora ? dados : null;
  } catch (_e) { return null; }
}
/** Comparação em tempo constante. */
export function iguais(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- chamadas ao Google ----------

export function urlDeAutorizacao(p: { clientId: string; redirectUri: string; estado: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: ESCOPOS,
    access_type: 'offline', prompt: 'consent', state: p.estado,
  });
  return GOOGLE_AUTH + '?' + q.toString();
}

async function postForm(f: any, url: string, dados: Record<string, string>): Promise<any> {
  const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(dados).toString() });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e: any = new Error(json.error_description || json.error || 'Falha ao falar com o Google (' + r.status + ')');
    e.codigo = json.error;
    throw e;
  }
  return json;
}

export function trocarCodigo(p: { fetch: any; clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<any> {
  return postForm(p.fetch, GOOGLE_TOKEN, {
    code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code',
  });
}
export async function renovarAcesso(p: { fetch: any; clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const j = await postForm(p.fetch, GOOGLE_TOKEN, {
    refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token',
  });
  return j.access_token;
}
export async function emailDoGoogle(f: any, accessToken: string): Promise<string | null> {
  const r = await f(GOOGLE_USERINFO, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) return null;
  return (await r.json()).email || null;
}
export async function criarAgendaRotina(f: any, accessToken: string): Promise<string> {
  const r = await f(GOOGLE_API + '/calendars', {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: NOME_AGENDA, description: 'Atividades planejadas no Minha Rotina', timeZone: TZ }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Não foi possível criar a agenda "' + NOME_AGENDA + '" (' + r.status + ')');
  return j.id;
}
/** A agenda ainda existe no Google (o usuário pode ter apagado)? */
export async function agendaExiste(f: any, accessToken: string, calendarId: string): Promise<boolean> {
  const r = await f(GOOGLE_API + '/calendars/' + encodeURIComponent(calendarId), { headers: { Authorization: 'Bearer ' + accessToken } });
  return r.ok;
}
export async function revogar(f: any, token: string): Promise<void> {
  try { await f('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }); } catch (_e) { /* melhor esforço */ }
}

/** Cria um evento. 'existente' quando o id já existe (a mesma ocorrência já foi criada antes): nunca duplica. */
export async function criarEvento(f: any, accessToken: string, calendarId: string, evento: any): Promise<{ status: string; mensagem?: string }> {
  const r = await f(GOOGLE_API + '/calendars/' + encodeURIComponent(calendarId) + '/events', {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(evento),
  });
  if (r.ok) return { status: 'criado' };
  if (r.status === 409) return { status: 'existente' };
  const j = await r.json().catch(() => ({}));
  return { status: 'erro', mensagem: (j.error && j.error.message) || 'HTTP ' + r.status };
}

/** Reescreve o evento (PUT) com o estado atual: concluída = ✓ + cinza; desfeita = volta ao normal. */
export async function atualizarEvento(f: any, accessToken: string, calendarId: string, evento: any): Promise<{ status: string; mensagem?: string }> {
  const r = await f(GOOGLE_API + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(evento.id), {
    method: 'PUT', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(evento),
  });
  if (r.ok) return { status: 'atualizado' };
  if (r.status === 404 || r.status === 410) return { status: 'inexistente' };   // apagado à mão no Google: não recria
  const j = await r.json().catch(() => ({}));
  return { status: 'erro', mensagem: (j.error && j.error.message) || 'HTTP ' + r.status };
}

export async function removerEvento(f: any, accessToken: string, calendarId: string, eventId: string): Promise<{ status: string; mensagem?: string }> {
  const r = await f(GOOGLE_API + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (r.ok) return { status: 'removido' };
  if (r.status === 404 || r.status === 410) return { status: 'inexistente' };   // já não existe: objetivo cumprido
  const j = await r.json().catch(() => ({}));
  return { status: 'erro', mensagem: (j.error && j.error.message) || 'HTTP ' + r.status };
}

/**
 * Exclui do Google os eventos cujas atividades foram apagadas no site (fila agenda_google_exclusoes).
 * Evita eventos órfãos/duplicados quando uma programação é salva de novo. Devolve quantos foram removidos.
 */
export async function processarExclusoes(p: { db: any; fetch: any; token: string; conta: any }): Promise<{ removidos: number; erros: string[] }> {
  let removidos = 0;
  const erros: string[] = [];
  for (const x of await p.db.listarExclusoes(p.conta.user_id)) {
    const res = await removerEvento(p.fetch, p.token, p.conta.calendar_id, x.event_id);
    if (res.status === 'removido' || res.status === 'inexistente') {
      await p.db.removerExclusao(x.id);
      if (res.status === 'removido') removidos++;
    } else if (erros.length < 3) erros.push(res.mensagem || 'erro');   // fica na fila para a próxima tentativa
  }
  return { removidos, erros };
}

/**
 * Datas específicas criadas/alteradas para o MESMO DIA: o evento vai para o Google na hora (não espera as 23:00).
 * Antes, exclui os eventos antigos das atividades que foram substituídas. Só entram atividades de datas específicas,
 * ainda agendadas, que ainda não terminaram e ainda sem evento. Os modelos que repetem seguem a regra das 23:00 do dia anterior.
 * db: { listarContas(userId), listarExclusoes, removerExclusao, listarOcorrenciasHoje(userId, data), marcarCriada, registrarExecucao, registrarErroConta }
 */
export async function criarEventosDeHoje(p: { db: any; fetch: any; clientId: string; clientSecret: string; userId: string; agora?: Date }): Promise<any[]> {
  const data = dataEmSaoPaulo(p.agora);
  const contas = await p.db.listarContas(p.userId);
  const resultados: any[] = [];
  for (const conta of contas) {
    const r = { user_id: conta.user_id, data_alvo: data, origem: 'manual', tipo: 'criacao', criados: 0, existentes: 0, marcados: 0, removidos: 0, erros: 0, detalhe: null as string | null };
    const erros: string[] = [];
    try {
      const token = await renovarAcesso({ fetch: p.fetch, clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: conta.refresh_token });
      const ex = await processarExclusoes({ db: p.db, fetch: p.fetch, token, conta });
      r.removidos = ex.removidos; erros.push(...ex.erros); r.erros += ex.erros.length;
      for (const oc of await p.db.listarOcorrenciasHoje(conta.user_id, data)) {
        const res = await criarEvento(p.fetch, token, conta.calendar_id, montarEvento(oc));
        if (res.status === 'criado') { r.criados++; await p.db.marcarCriada(oc.id, idEventoDeOcorrencia(oc.id)); }
        else if (res.status === 'existente') { r.existentes++; await p.db.marcarCriada(oc.id, idEventoDeOcorrencia(oc.id)); }
        else { r.erros++; if (erros.length < 3) erros.push(oc.titulo_planejado + ': ' + res.mensagem); }
      }
      if (erros.length) r.detalhe = erros.join(' | ');
      await erroContaSeguro(p.db, conta.user_id, erros.length ? erros[0] : null, r);
    } catch (e: any) {
      r.erros++;
      r.detalhe = e.codigo === 'invalid_grant' ? 'A autorização do Google expirou ou foi revogada. Conecte novamente.' : String((e && e.message) || e);
      await erroContaSeguro(p.db, conta.user_id, r.detalhe, r);
    }
    if (r.criados || r.existentes || r.removidos || r.erros) await registrarSeguro(p.db, r);
    resultados.push(r);
  }
  return resultados;
}

/**
 * Mantém o Google Agenda de acordo com o site (idempotente):
 *   1) concluída no site => evento com ✓ e cinza; conclusão desfeita => evento volta ao normal;
 *   2) no fim do dia (datas ANTERIORES a hoje): evento que não foi concluído é EXCLUÍDO, para não ficar como pendente.
 * Eventos concluídos permanecem como histórico. Se o evento foi apagado à mão no Google, não é recriado.
 * db: { listarContas(userId?), listarParaMarcar(userId), listarParaExcluir(userId, hoje), registrarMarcacao(id, concluido),
 *       registrarRemocao(id), registrarErroConta(userId, msg), registrarExecucao(x) }
 */
export async function reconciliarEventos(p: { db: any; fetch: any; clientId: string; clientSecret: string; origem: 'agendado' | 'manual'; userId?: string; agora?: Date }): Promise<any[]> {
  const hoje = dataEmSaoPaulo(p.agora);
  const contas = await p.db.listarContas(p.userId);
  const resultados: any[] = [];
  for (const conta of contas) {
    const r = { user_id: conta.user_id, data_alvo: hoje, origem: p.origem, tipo: 'conclusao_limpeza', criados: 0, existentes: 0, marcados: 0, removidos: 0, erros: 0, detalhe: null as string | null };
    const erros: string[] = [];
    try {
      const token = await renovarAcesso({ fetch: p.fetch, clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: conta.refresh_token });
      const ex = await processarExclusoes({ db: p.db, fetch: p.fetch, token, conta });   // atividades apagadas no site
      r.removidos += ex.removidos; r.erros += ex.erros.length; erros.push(...ex.erros);
      for (const oc of await p.db.listarParaMarcar(conta.user_id)) {
        const res = await atualizarEvento(p.fetch, token, conta.calendar_id, montarEvento(oc));
        if (res.status === 'atualizado') { r.marcados++; await p.db.registrarMarcacao(oc.id, oc.status === 'concluida'); }
        else if (res.status === 'inexistente') await p.db.registrarRemocao(oc.id);
        else { r.erros++; if (erros.length < 3) erros.push(oc.titulo_planejado + ': ' + res.mensagem); }
      }
      for (const oc of await p.db.listarParaExcluir(conta.user_id, hoje)) {
        const res = await removerEvento(p.fetch, token, conta.calendar_id, idEventoDeOcorrencia(oc.id));
        if (res.status === 'removido') { r.removidos++; await p.db.registrarRemocao(oc.id); }
        else if (res.status === 'inexistente') await p.db.registrarRemocao(oc.id);
        else { r.erros++; if (erros.length < 3) erros.push(oc.titulo_planejado + ': ' + res.mensagem); }
      }
      if (erros.length) r.detalhe = erros.join(' | ');
      await erroContaSeguro(p.db, conta.user_id, erros.length ? erros[0] : null, r);
    } catch (e: any) {
      r.erros++;
      r.detalhe = e.codigo === 'invalid_grant' ? 'A autorização do Google expirou ou foi revogada. Conecte novamente.' : String((e && e.message) || e);
      await erroContaSeguro(p.db, conta.user_id, r.detalhe, r);
    }
    if (r.marcados || r.removidos || r.erros) await registrarSeguro(p.db, r);   // só registra quando houve algo
    resultados.push(r);
  }
  return resultados;
}

// ---------- registro (secundário) ----------

/** O registro da execução é secundário: se falhar (ex.: SQL pendente), a operação já feita continua valendo e o motivo vai no resultado. */
async function registrarSeguro(db: any, r: any): Promise<void> {
  try { await db.registrarExecucao(r); }
  catch (e: any) {
    r.aviso = 'A operação foi concluída, mas o registro dela não pôde ser gravado (' + String((e && e.message) || e)
      + '). Execute os arquivos SQL pendentes de supabase/migrations (docs/CONFIGURACAO.md).';
  }
}
async function erroContaSeguro(db: any, userId: string, mensagem: string | null, r: any): Promise<void> {
  try { await db.registrarErroConta(userId, mensagem); }
  catch (e: any) { if (!r.aviso) r.aviso = 'Não foi possível gravar o estado da conta (' + String((e && e.message) || e) + ').'; }
}

// ---------- sincronização do dia seguinte ----------

/**
 * Cria no Google Agenda os eventos de AMANHÃ (somente) das pessoas conectadas.
 * db: { listarContas(userId?), listarOcorrencias(userId, data), marcarCriada(id, eventId), registrarExecucao(x), registrarErroConta(userId, msg) }
 */
export async function sincronizarAmanha(p: { db: any; fetch: any; clientId: string; clientSecret: string; origem: 'agendado' | 'manual'; userId?: string; agora?: Date }): Promise<any[]> {
  const data = amanhaEmSaoPaulo(p.agora);
  const contas = await p.db.listarContas(p.userId);
  const resultados: any[] = [];
  for (const conta of contas) {
    const r = { user_id: conta.user_id, data_alvo: data, origem: p.origem, criados: 0, existentes: 0, erros: 0, detalhe: null as string | null };
    try {
      const token = await renovarAcesso({ fetch: p.fetch, clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: conta.refresh_token });
      const ocs = await p.db.listarOcorrencias(conta.user_id, data);   // só status 'agendada' e ainda sem evento
      const erros: string[] = [];
      for (const oc of ocs) {
        const res = await criarEvento(p.fetch, token, conta.calendar_id, montarEvento(oc));
        if (res.status === 'criado') { r.criados++; await p.db.marcarCriada(oc.id, idEventoDeOcorrencia(oc.id)); }
        else if (res.status === 'existente') { r.existentes++; await p.db.marcarCriada(oc.id, idEventoDeOcorrencia(oc.id)); }
        else { r.erros++; if (erros.length < 3) erros.push(oc.titulo_planejado + ': ' + res.mensagem); }
      }
      if (erros.length) r.detalhe = erros.join(' | ');
      await erroContaSeguro(p.db, conta.user_id, erros.length ? erros[0] : null, r);
    } catch (e: any) {
      r.erros++;
      r.detalhe = e.codigo === 'invalid_grant'
        ? 'A autorização do Google expirou ou foi revogada. Conecte novamente.'
        : String(e && e.message || e);
      await erroContaSeguro(p.db, conta.user_id, r.detalhe, r);
    }
    await registrarSeguro(p.db, r);
    resultados.push(r);
  }
  return resultados;
}
