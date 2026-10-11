/*
 * Conexão com o Supabase: login (Supabase Auth) e leitura do catálogo real.
 * Somente LEITURA de rotina / exercicios / listas_area — nada é alterado nessas tabelas.
 */
(function (A) {
  'use strict';

  const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  let cliente = null;

  function configurado() {
    return !!(A.config && A.config.url && A.config.chave);
  }

  /** Recusa chaves administrativas: elas ignoram o RLS e não podem ficar no navegador. */
  function validarChave(chave) {
    if (/^sb_secret_/.test(chave)) throw new Error('A chave configurada é SECRETA (sb_secret_). Use a chave pública (anon/publishable).');
    const partes = chave.split('.');
    if (partes.length === 3) {
      let role = null;
      try { role = JSON.parse(atob(partes[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch (e) { /* não é JWT legível */ }
      if (role === 'service_role') throw new Error('A chave configurada é a service_role. Use a chave pública "anon".');
    }
  }

  function carregarScript(src) {
    return new Promise(function (ok, falha) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { falha(new Error('Não foi possível carregar a biblioteca do Supabase. Verifique a internet.')); };
      document.head.appendChild(s);
    });
  }

  function traduzirErro(e) {
    const msg = (e && e.message) || String(e);
    if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(msg)) return 'E-mail ainda não confirmado.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sem conexão com o Supabase.';
    return msg;
  }

  async function iniciar() {
    validarChave(A.config.chave);
    if (!window.supabase) await carregarScript(LIB);
    cliente = window.supabase.createClient(A.config.url, A.config.chave, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  async function sessao() {
    const r = await cliente.auth.getSession();
    if (r.error) throw new Error(traduzirErro(r.error));
    return r.data.session;
  }

  async function entrar(email, senha) {
    const r = await cliente.auth.signInWithPassword({ email: email, password: senha });
    if (r.error) throw new Error(traduzirErro(r.error));
    return r.data.session;
  }

  async function sair() {
    await cliente.auth.signOut();
  }

  function aoSair(fn) {
    cliente.auth.onAuthStateChange(function (evento) { if (evento === 'SIGNED_OUT') fn(); });
  }

  /** '-' e vazio são marcadores de "sem link" nos dados atuais. */
  function urlValida(u) {
    u = (u || '').trim();
    return /^https?:\/\//i.test(u) ? u : null;
  }

  /** Lê rotina + exercicios (com a área) e devolve no formato de catálogo usado pelas telas. */
  async function carregarCatalogo() {
    const [rot, exe] = await Promise.all([
      cliente.from('rotina').select('id_rotina, titulo, url_rotina, duracao_segundos').order('id_rotina'),
      cliente.from('exercicios')
        .select('id_exercicio, id_area, titulo, url_exercicio, ordem, duracao_segundos, listas_area(nome, categoria)')
        .order('id_area').order('ordem').order('id_exercicio'),
    ]);
    if (rot.error) throw new Error('Erro ao ler rotina: ' + traduzirErro(rot.error));
    if (exe.error) throw new Error('Erro ao ler exercicios: ' + traduzirErro(exe.error));

    return rot.data.map(function (r) {
      return { tipo: 'rotina', id_origem: r.id_rotina, titulo: r.titulo, duracao_segundos: r.duracao_segundos,
        url: urlValida(r.url_rotina), id_area: null, area: null, categoria: 'Rotina', ordem: null,
        planejavel: r.duracao_segundos > 0 };
    }).concat(exe.data.map(function (e) {
      const area = e.listas_area || {};
      return { tipo: 'exercicio', id_origem: e.id_exercicio, titulo: e.titulo, duracao_segundos: e.duracao_segundos,
        url: urlValida(e.url_exercicio), id_area: e.id_area, area: area.nome || 'Área ' + e.id_area,
        categoria: area.categoria || 'Sem categoria', ordem: e.ordem, planejavel: e.duracao_segundos > 0 };
    }));
  }

  // ---------- Google Agenda (a conversa com o Google é feita pela função google-agenda no servidor) ----------
  async function chamarFuncao(rota, metodo) {
    const s = await sessao();
    if (!s) throw new Error('Sessão expirada. Entre novamente.');
    let r;
    try {
      r = await fetch(A.config.url + '/functions/v1/google-agenda' + rota, { method: metodo, headers: { Authorization: 'Bearer ' + s.access_token, apikey: A.config.chave } });
    } catch (e) { throw new Error('Não foi possível falar com a função google-agenda. Ela já foi publicada? (docs/CONFIGURACAO.md)'); }
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.erro || j.message || 'Erro ' + r.status + ' na integração com o Google.');
    return j;
  }
  async function googleStatus() {
    const r = await cliente.rpc('agenda_google_status');
    if (r.error) throw new Error(/does not exist|schema cache/i.test(r.error.message) ? 'Execute o SQL de supabase/migrations antes (docs/CONFIGURACAO.md).' : r.error.message);
    return r.data;
  }
  async function googleUrlDeConexao() { return (await chamarFuncao('/auth-url', 'GET')).url; }
  function googleSincronizar() { return chamarFuncao('/sync', 'POST'); }
  function googleCriarHoje() { return chamarFuncao('/criar-hoje', 'POST'); }
  function googleReconciliar() { return chamarFuncao('/reconciliar', 'POST'); }
  function googleDesconectar() { return chamarFuncao('/disconnect', 'POST'); }

  A.conexao = {
    cliente: function () { return cliente; },
    googleStatus: googleStatus, googleUrlDeConexao: googleUrlDeConexao, googleSincronizar: googleSincronizar, googleReconciliar: googleReconciliar, googleCriarHoje: googleCriarHoje, googleDesconectar: googleDesconectar,
    configurado: configurado, iniciar: iniciar, sessao: sessao, entrar: entrar, sair: sair,
    aoSair: aoSair, carregarCatalogo: carregarCatalogo,
  };
})(window.Agenda = window.Agenda || {});
