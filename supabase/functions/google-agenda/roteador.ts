/*
 * Rotas HTTP da função google-agenda. Recebe as dependências (env, fetch, banco) por parâmetro para poder ser testada fora do Supabase.
 *
 *   GET  /auth-url    (login do site)   devolve a URL de autorização do Google
 *   GET  /callback    (Google)          recebe o código, guarda o token no servidor e cria a agenda "Rotina"
 *   POST /sync        (cron ou login)   cria no Google os eventos de AMANHÃ
 *   POST /reconciliar (cron ou login)   marca ✓ o que foi concluído no site e exclui, no fim do dia, o que não foi concluído
 *   POST /criar-hoje  (login do site)   cria na hora os eventos das datas específicas do dia (e limpa os substituídos)
 *   POST /disconnect  (login do site)   revoga o acesso e apaga o token
 */
import {
  agendaExiste, assinarEstado, criarAgendaRotina, emailDoGoogle, ESCOPOS, iguais, lerEstado, revogar,
  criarEventosDeHoje, reconciliarEventos, sincronizarAmanha, trocarCodigo, urlDeAutorizacao,
} from './nucleo.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',   // a autenticação é por token (sem cookies), então não há risco de CSRF
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(corpo: any, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function esc(t: string): string {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}
/** Página mostrada na janela aberta pelo site; avisa o site e fecha sozinha. */
function pagina(ok: boolean, mensagem: string): Response {
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Google Agenda</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;text-align:center;color:#222}'
    + 'h1{font-size:1.3rem}p{color:#555}</style></head><body><h1>' + (ok ? '✓ Google Agenda conectado' : 'Não foi possível conectar') + '</h1><p>'
    + esc(mensagem) + '</p><p><small>Você pode fechar esta janela.</small></p>'
    + '<script>try{window.opener&&window.opener.postMessage({tipo:"agenda-google",ok:' + (ok ? 'true' : 'false') + '},"*")}catch(e){}'
    + (ok ? 'setTimeout(function(){window.close()},1500)' : '') + '</script></body></html>';
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function tratar(req: Request, deps: any): Promise<Response> {
  const { env, fetch: f, db } = deps;
  const agora: Date = deps.agora ? deps.agora() : new Date();
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^\/(functions\/v1\/)?google-agenda/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const faltando = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STATE_SECRET', 'CRON_SECRET', 'SUPABASE_URL'].filter((k) => !env[k]);
  const redirectUri = (env.SUPABASE_URL || '') + '/functions/v1/google-agenda/callback';

  async function usuario(): Promise<{ id: string } | null> {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
    return m ? await db.usuarioDoToken(m[1]) : null;
  }

  try {
    if (faltando.length && rota !== '/callback') {
      return json({ erro: 'Integração não configurada. Faltam os segredos: ' + faltando.join(', ') + '. Veja docs/CONFIGURACAO.md.' }, 503);
    }

    if (rota === '/auth-url' && req.method === 'GET') {
      const u = await usuario();
      if (!u) return json({ erro: 'Entre no site antes de conectar.' }, 401);
      const estado = await assinarEstado(env.STATE_SECRET, { u: u.id, exp: agora.getTime() + 10 * 60 * 1000 });
      return json({ url: urlDeAutorizacao({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, estado }), escopos: ESCOPOS });
    }

    if (rota === '/callback' && req.method === 'GET') {
      if (faltando.length) return pagina(false, 'Integração não configurada no servidor.');
      if (url.searchParams.get('error')) return pagina(false, 'O acesso foi negado no Google (' + url.searchParams.get('error') + ').');
      const estado = await lerEstado(env.STATE_SECRET, url.searchParams.get('state') || '', agora.getTime());
      if (!estado) return pagina(false, 'O link de autorização expirou ou é inválido. Volte ao site e tente de novo.');
      const code = url.searchParams.get('code');
      if (!code) return pagina(false, 'O Google não enviou o código de autorização.');
      const t = await trocarCodigo({ fetch: f, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri, code });
      const existente = await db.obterConta(estado.u);
      const refresh = t.refresh_token || (existente && existente.refresh_token);
      if (!refresh) return pagina(false, 'O Google não devolveu a permissão de uso contínuo. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.');
      let calendarId = existente && existente.calendar_id;
      if (!calendarId || !(await agendaExiste(f, t.access_token, calendarId))) calendarId = await criarAgendaRotina(f, t.access_token);
      const email = await emailDoGoogle(f, t.access_token);
      await db.salvarConta({ user_id: estado.u, google_email: email, refresh_token: refresh, calendar_id: calendarId, escopo: t.scope || ESCOPOS });
      return pagina(true, 'Os eventos de cada dia seguinte serão criados na agenda "Rotina"' + (email ? ' de ' + email : '') + ' às 23:00.');
    }

    if (rota === '/sync' && req.method === 'POST') {
      const segredo = req.headers.get('x-cron-secret');
      const config = { db, fetch: f, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, agora };
      if (segredo && iguais(segredo, env.CRON_SECRET)) {
        return json({ resultados: await sincronizarAmanha({ ...config, origem: 'agendado' }) });
      }
      const u = await usuario();
      if (!u) return json({ erro: 'Não autorizado.' }, 401);
      // execução manual: só da própria pessoa e, igual ao agendado, somente o dia seguinte
      return json({ resultados: await sincronizarAmanha({ ...config, origem: 'manual', userId: u.id }) });
    }

    if (rota === '/reconciliar' && req.method === 'POST') {
      const segredo = req.headers.get('x-cron-secret');
      const config = { db, fetch: f, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, agora };
      if (segredo && iguais(segredo, env.CRON_SECRET)) return json({ resultados: await reconciliarEventos({ ...config, origem: 'agendado' }) });
      const u = await usuario();
      if (!u) return json({ erro: 'Não autorizado.' }, 401);
      return json({ resultados: await reconciliarEventos({ ...config, origem: 'manual', userId: u.id }) });   // só a própria pessoa
    }

    if (rota === '/criar-hoje' && req.method === 'POST') {
      const u = await usuario();
      if (!u) return json({ erro: 'Não autorizado.' }, 401);   // só pelo site, para a própria pessoa
      return json({ resultados: await criarEventosDeHoje({ db, fetch: f, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, userId: u.id, agora }) });
    }

    if (rota === '/disconnect' && req.method === 'POST') {
      const u = await usuario();
      if (!u) return json({ erro: 'Não autorizado.' }, 401);
      const conta = await db.obterConta(u.id);
      if (conta) await revogar(f, conta.refresh_token);
      await db.removerConta(u.id);
      return json({ ok: true });
    }

    return json({ erro: 'Rota não encontrada.' }, 404);
  } catch (e: any) {
    return json({ erro: String((e && e.message) || e) }, 500);
  }
}
