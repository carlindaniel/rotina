/*
 * Telas do site. Só conversa com a camada de dados D (criada em iniciar()).
 */
(function (A) {
  'use strict';

  const H = A.horarios, I = A.indicadores;
  let D = null;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const conteudo = $('#conteudo');

  let catalogo = [], motivos = [];
  let ocCache = {};          // ocorrências da tela atual, por id (usado pelos botões de ação)
  let rotaAtual = null, paramsAtuais = {};

  // ---------- Utilidades ----------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  let toastTimer;
  function toast(msg, erro) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast visivel' + (erro ? ' erro' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, erro ? 5000 : 2500);
  }

  function abrirModal(titulo, corpoHtml, okTexto) {
    return new Promise(function (resolve) {
      const dlg = $('#modal');
      $('#modal-titulo').textContent = titulo;
      $('#modal-corpo').innerHTML = corpoHtml;
      $('#modal-ok').textContent = okTexto || 'Salvar';
      dlg.returnValue = '';
      dlg.onclose = function () {
        resolve(dlg.returnValue === 'ok' ? new FormData($('#modal-form')) : null);
      };
      dlg.showModal();
      const primeiro = dlg.querySelector('#modal-corpo input, #modal-corpo select, #modal-corpo textarea');
      if (primeiro) primeiro.focus();
    });
  }

  // ---------- Visor de descrição (Google Docs/Sheets/Slides, texto ou texto formatado) ----------
  /** Converte links do Google Docs/Sheets/Slides para a versão incorporável (mesma regra de treinar/rotina.html). */
  function urlIncorporavel(url) {
    const m = url.match(/^(https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]+)/);
    if (!m) return url;
    if (m[2] === 'presentation') return m[1] + '/embed?start=false&loop=false';
    if (m[2] === 'spreadsheets') return m[1] + '/htmlview?widget=true&headers=false';
    return m[1] + '/preview';
  }
  function ehLink(v) { return /^https?:\/\/\S+$/i.test(v); }
  function ehHtml(v) { return /^</.test(v); }
  /** Texto com quebras de linha e links clicáveis (já escapado). */
  function textoComLinks(t) {
    return esc(t).replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
  }

  // Texto formatado: só estas marcações sobrevivem (o resto vira texto). Cobre o que se cola do Google Docs.
  const TAGS_DESC = { P: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, H1: 1, H2: 1, H3: 1, UL: 1, OL: 1, LI: 1, A: 1,
    BLOCKQUOTE: 1, HR: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1 };
  const DESCARTAR = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1, SVG: 1, MATH: 1 };
  function limparHtml(html) {
    const origem = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html').body;
    function copiar(no, destino) {
      Array.prototype.forEach.call(no.childNodes, function (n) {
        if (n.nodeType === 3) { destino.appendChild(document.createTextNode(n.nodeValue)); return; }
        if (n.nodeType !== 1 || DESCARTAR[n.tagName]) return;
        const st = n.style || {}, peso = String(st.fontWeight || '');
        let alvo = destino;
        // o Google Docs embrulha tudo num <b style="font-weight:normal">: esse <b> é descartado
        if (TAGS_DESC[n.tagName] && !((n.tagName === 'B' || n.tagName === 'STRONG') && /^(normal|[1-5]00)$/.test(peso))) {
          alvo = document.createElement(n.tagName);
          if (n.tagName === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
            alvo.setAttribute('href', n.getAttribute('href')); alvo.setAttribute('target', '_blank'); alvo.setAttribute('rel', 'noopener');
          }
          ['colspan', 'rowspan'].forEach(function (a) { if (/^\d{1,2}$/.test(n.getAttribute(a) || '')) alvo.setAttribute(a, n.getAttribute(a)); });
          destino.appendChild(alvo);
        } else if (n.tagName === 'DIV') {
          alvo = destino.appendChild(document.createElement('p'));
        }
        // o Google Docs marca negrito/itálico/sublinhado por estilo em <span>
        if (/^(bold|[6-9]00)$/.test(peso) && !/^(B|STRONG|H\d|TH)$/.test(alvo.tagName)) alvo = alvo.appendChild(document.createElement('b'));
        if (st.fontStyle === 'italic' && !/^(I|EM)$/.test(alvo.tagName)) alvo = alvo.appendChild(document.createElement('i'));
        if (/underline/.test(st.textDecoration || st.textDecorationLine || '') && n.tagName !== 'A' && alvo.tagName !== 'U') alvo = alvo.appendChild(document.createElement('u'));
        copiar(n, alvo);
      });
    }
    const out = document.createElement('div');
    copiar(origem, out);
    out.querySelectorAll('p, h1, h2, h3, li').forEach(function (el) { if (!el.textContent.trim() && !el.querySelector('br')) el.remove(); });
    return out.innerHTML;
  }
  /** Conteúdo salvo -> HTML da página (texto simples ganha parágrafos e links). */
  function htmlDaPagina(v) {
    if (ehHtml(v)) return limparHtml(v);
    return v.split(/\n{2,}/).map(function (par) { return '<p>' + textoComLinks(par).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  const visor = { aoSalvar: null, conteudo: '', editando: false, sujo: false };
  /**
   * Abre o visor. Um link sozinho é incorporado (Google Docs etc.); texto aparece numa página no estilo do Google Docs.
   * opcoes.aoSalvar(valor) torna o conteúdo editável; opcoes.editar abre já no modo de edição; opcoes.rotuloSalvar muda o botão.
   */
  function abrirVisor(titulo, conteudoDesc, opcoes) {
    opcoes = opcoes || {};
    Object.assign(visor, { aoSalvar: opcoes.aoSalvar || null, conteudo: (conteudoDesc || '').trim(), sujo: false });
    $('#visor-titulo').textContent = titulo;
    $('#visor-salvar').textContent = opcoes.rotuloSalvar || 'Salvar';
    const dlg = $('#visor');
    dlg.onclose = function () { $('#visor-frame').src = 'about:blank'; };
    if (opcoes.editar) editarVisor(); else mostrarVisor();
    if (!dlg.open) dlg.showModal();
    if (visor.editando) $('#visor-pagina').focus();
  }
  function mostrarVisor() {
    const v = visor.conteudo, link = ehLink(v) ? v : null, pagina = $('#visor-pagina'), frame = $('#visor-frame');
    const src = link ? urlIncorporavel(link) : 'about:blank';
    visor.editando = false;
    $('#visor-doc').hidden = !link;
    $('#visor-folha').hidden = !!link;
    $('#visor-ferramentas').hidden = true;
    $('#visor-links').hidden = !link;
    pagina.contentEditable = 'false';
    pagina.innerHTML = link ? '' : v ? htmlDaPagina(v)
      : '<p class="doc-vazio">Sem descrição.' + (visor.aoSalvar ? ' Clique em Editar para escrever.' : '') + '</p>';
    if (frame.getAttribute('src') !== src) frame.src = src;
    $('#visor-abrir').href = link || '#';
    $('#visor-editar').hidden = !visor.aoSalvar;
    $('#visor-cancelar').hidden = $('#visor-salvar').hidden = true;
    $('#visor-fechar').hidden = false;
  }
  function editarVisor() {
    const v = visor.conteudo, pagina = $('#visor-pagina');
    visor.editando = true; visor.sujo = false;
    $('#visor-doc').hidden = true; $('#visor-frame').src = 'about:blank';
    $('#visor-folha').hidden = false;
    $('#visor-ferramentas').hidden = false;
    $('#visor-links').hidden = true;
    pagina.innerHTML = v ? htmlDaPagina(v) : '<p><br></p>';
    pagina.contentEditable = 'true';
    $('#visor-editar').hidden = $('#visor-fechar').hidden = true;
    $('#visor-cancelar').hidden = $('#visor-salvar').hidden = false;
    pagina.focus();
  }
  /** Conteúdo do editor -> valor a gravar: vazio, um link sozinho (será incorporado) ou HTML limpo. */
  function valorDoEditor() {
    const pagina = $('#visor-pagina'), texto = pagina.innerText.trim();
    if (!texto && !pagina.querySelector('hr, table')) return '';
    if (ehLink(texto) && !pagina.querySelector('b, strong, i, em, u, h1, h2, h3, ul, ol, table')) return texto;
    return limparHtml(pagina.innerHTML);
  }
  $('#visor-pagina').addEventListener('input', function () { visor.sujo = true; });
  $('#visor-pagina').addEventListener('paste', function (e) {   // cola do Google Docs mantendo só a formatação suportada
    const dados = e.clipboardData;
    if (!dados || !visor.editando) return;
    e.preventDefault();
    const html = dados.getData('text/html');
    document.execCommand('insertHTML', false, html ? limparHtml(html) : htmlDaPagina(dados.getData('text/plain')));
  });
  $('#visor-ferramentas').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });   // não tira o cursor do texto
  $('#visor-ferramentas').addEventListener('click', function (e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.bloco) document.execCommand('formatBlock', false, '<' + b.dataset.bloco + '>');
    else if (b.dataset.cmd === 'createLink') {
      const url = prompt('Endereço do link (https://...)');
      if (url && /^https?:\/\//i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      else if (url) toast('Use um endereço começando com https://', true);
    } else document.execCommand(b.dataset.cmd, false, null);
    visor.sujo = true;
    $('#visor-pagina').focus();
  });
  $('#visor-editar').addEventListener('click', editarVisor);
  $('#visor-cancelar').addEventListener('click', function () {
    if (visor.sujo && !confirm('Descartar as alterações da descrição?')) return;
    mostrarVisor();
  });
  $('#visor-salvar').addEventListener('click', async function () {
    const b = this, valor = valorDoEditor();
    b.disabled = true;
    try {
      await visor.aoSalvar(valor);
      visor.conteudo = valor;
      mostrarVisor();
    } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
  });
  $('#visor').addEventListener('cancel', function (e) {   // Esc
    if (visor.editando && visor.sujo && !confirm('Descartar as alterações da descrição?')) e.preventDefault();
  });
  $('#visor-recarregar').addEventListener('click', function () {
    const f = $('#visor-frame'), src = f.src;
    f.src = 'about:blank';
    setTimeout(function () { f.src = src; }, 50);
  });
  /** Resumo de uma linha da descrição (Planejamento). */
  function resumoDescricao(v) {
    v = (v || '').trim();
    if (!v) return '';
    if (ehLink(v)) return v;
    const div = document.createElement('div');
    div.innerHTML = htmlDaPagina(v);
    const t = div.textContent.replace(/\s+/g, ' ').trim();
    return t.length > 140 ? t.slice(0, 140) + '…' : t;
  }

  const STATUS = {
    agendada: { rotulo: 'Agendada', icone: '○', cls: 'st-agendada' },
    em_andamento: { rotulo: 'Em andamento', icone: '▶', cls: 'st-andamento' },
    concluida: { rotulo: 'Concluída', icone: '✓', cls: 'st-ok' },
    nao_realizada: { rotulo: 'Não realizada', icone: '✕', cls: 'st-falha' },
    cancelada: { rotulo: 'Cancelada', icone: '⊘', cls: 'st-cancelada' },
    atrasada: { rotulo: 'Atrasada', icone: '!', cls: 'st-atraso' },
  };
  function statusVisual(o) {
    return o.status === 'agendada' && o.fim_planejado < Date.now() ? 'atrasada' : o.status;
  }
  function chip(o) {
    const s = STATUS[statusVisual(o)];
    return '<span class="chip ' + s.cls + '"><span aria-hidden="true">' + s.icone + '</span> ' + s.rotulo + '</span>';
  }
  function nomeMotivo(id) {
    const m = motivos.find(function (x) { return x.id === id; });
    return m ? m.descricao : null;
  }
  function chaveCat(c) { return c.tipo + ':' + c.id_origem; }
  function buscarCat(chave) { return catalogo.find(function (c) { return chaveCat(c) === chave; }); }

  // ---------- Linha de ocorrência (Painel e Execução) ----------
  function acoesDisponiveis(o) {
    const hoje = H.hojeIso();
    const a = [];
    if (o.status === 'agendada') {
      if (o.data === hoje) a.push(['iniciar', 'Iniciar']);
      if (o.data <= hoje) a.push(['concluir', 'Concluir'], ['nao', 'Não realizada']);
      a.push(['editar', 'Ajustar'], ['cancelar', 'Cancelar']);
    } else if (o.status === 'em_andamento') {
      a.push(['concluir', 'Concluir'], ['nao', 'Não realizada'], ['desfazer', 'Desfazer']);
    } else if (o.status === 'nao_realizada') {
      a.push(['concluir', 'Registrar conclusão'], ['desfazer', 'Desfazer']);
    } else {
      a.push(['desfazer', o.status === 'cancelada' ? 'Reativar' : 'Desfazer']);
    }
    return a;
  }

  function linhaOcorrencia(o, compacta) {
    ocCache[o.id] = o;
    const meta = [o.categoria_planejada, o.area_planejada, H.duracaoTexto(o.duracao_planejada_seg)]
      .filter(Boolean);
    if (o.duracao_real_seg != null) meta.push('real ' + H.duracaoTexto(o.duracao_real_seg));
    if (o.concluido_em) meta.push('concluída às ' + H.horaDe(o.concluido_em));
    if (o.editada_manualmente) meta.push('ajustada');
    const extra = [];
    if (o.status === 'nao_realizada') {
      extra.push(o.motivo_id ? 'Motivo: ' + esc(nomeMotivo(o.motivo_id))
        : (o.marcada_automaticamente ? 'Marcada automaticamente ao fim do dia' : 'Sem motivo informado'));
    }
    if (o.observacao) extra.push(esc(o.observacao));
    const emAberto = o.status === 'agendada' || o.status === 'em_andamento';
    const temDescricao = !!D.descricaoDe(o);
    const acoes = acoesDisponiveis(o).map(function (x, i) {
      return '<button type="button" class="btn' + (i === 0 && emAberto ? ' primario' : '') + ' pequeno" data-acao="'
        + x[0] + '" data-id="' + o.id + '">' + x[1] + '</button>';
    }).join('');
    return '<li class="oc ' + STATUS[statusVisual(o)].cls + '">'
      + '<div class="oc-hora"><strong>' + H.horaDe(o.inicio_planejado) + '</strong><span>'
      + H.horaDe(o.fim_planejado) + '</span></div>'
      + '<div class="oc-info"><div class="oc-titulo">' + esc(o.titulo_planejado)
      + (compacta && temDescricao ? ' <button type="button" class="link doc" data-acao="descricao" data-id="' + o.id + '">descrição</button>' : '')
      + '</div><div class="oc-meta">' + esc(meta.join(' · ')) + '</div>'
      + (extra.length ? '<div class="oc-extra">' + extra.join(' — ') + '</div>' : '')
      + '</div>'
      + '<div class="oc-estado">' + chip(o) + '</div>'
      + (compacta ? '' : '<div class="oc-acoes">' + acoes + '</div>')
      + (!compacta && temDescricao ? '<div class="oc-desc"><button type="button" class="btn pequeno" data-acao="descricao" data-id="' + o.id + '">Descrição</button></div>' : '')
      + '</li>';
  }

  // ---------- Ações sobre ocorrências ----------
  function opcoesMotivo() {
    return motivos.map(function (m) { return '<option value="' + m.id + '">' + esc(m.descricao) + '</option>'; }).join('');
  }

  async function executarAcao(acao, o) {
    if (acao === 'descricao') {
      const d = D.descricaoDe(o);
      if (!d) return;
      abrirVisor(o.titulo_planejado, d.conteudo, d.modelo_id ? {
        editar: !d.conteudo,
        aoSalvar: async function (v) { await D.salvarDescricao(d.modelo_id, v); toast('Descrição salva.'); },
      } : null);
      return;
    }
    const agora = Date.now();
    let patch = null;
    if (acao === 'iniciar') {
      patch = { status: 'em_andamento', iniciado_em: agora };
    } else if (acao === 'concluir') {
      const padrao = o.data === H.hojeIso() ? H.horaDe(agora) : H.horaDe(o.fim_planejado);
      const durPadrao = o.iniciado_em ? '' : H.duracaoEditavel(o.duracao_planejada_seg);
      const f = await abrirModal('Concluir: ' + o.titulo_planejado,
        '<label>Concluída às <input type="time" name="hora" required value="' + padrao + '"></label>'
        + '<label>Duração real <input name="dur" inputmode="numeric" placeholder="min ou min:seg" value="' + durPadrao + '">'
        + '<small>' + (o.iniciado_em ? 'Vazio = calculada a partir do início (' + H.horaDe(o.iniciado_em) + ').'
          : 'Vazio = não registrar duração real.') + '</small></label>'
        + '<label>Observação <textarea name="obs" rows="2">' + esc(o.observacao) + '</textarea></label>',
        'Concluir');
      if (!f) return;
      // horário não alterado no modal = agora (preserva os segundos); senão, o minuto informado
      const concluido = f.get('hora') === padrao && o.data === H.hojeIso()
        ? Date.now() : H.instante(o.data, H.horaParaSeg(f.get('hora')));
      if (concluido > Date.now() + 60000) throw new Error('O horário de conclusão está no futuro.');
      let dur = H.lerDuracao(f.get('dur'));
      if (Number.isNaN(dur)) throw new Error('Duração inválida. Use minutos (15) ou min:seg (1:30).');
      if (dur == null && o.iniciado_em) {
        if (concluido < o.iniciado_em - 60000) throw new Error('A conclusão é anterior ao início registrado.');
        dur = Math.max(0, Math.round((concluido - o.iniciado_em) / 1000));
      }
      patch = { status: 'concluida', concluido_em: concluido, duracao_real_seg: dur,
        observacao: f.get('obs').trim() || null };
    } else if (acao === 'nao') {
      const f = await abrirModal('Não realizada: ' + o.titulo_planejado,
        '<label>Motivo <select name="motivo" required><option value="">Escolha…</option>' + opcoesMotivo() + '</select></label>'
        + '<label>Observação <textarea name="obs" rows="2">' + esc(o.observacao) + '</textarea></label>',
        'Registrar');
      if (!f) return;
      patch = { status: 'nao_realizada', motivo_id: Number(f.get('motivo')),
        observacao: f.get('obs').trim() || null, marcada_automaticamente: false };
    } else if (acao === 'cancelar') {
      const f = await abrirModal('Cancelar: ' + o.titulo_planejado,
        '<p class="ajuda">Atividades canceladas não contam como falha.</p>'
        + '<label>Motivo (opcional) <textarea name="obs" rows="2"></textarea></label>', 'Cancelar atividade');
      if (!f) return;
      patch = { status: 'cancelada', observacao: f.get('obs').trim() || null };
    } else if (acao === 'editar') {
      const f = await abrirModal('Ajustar só este dia: ' + o.titulo_planejado,
        '<p class="ajuda">Altera apenas esta ocorrência. O modelo e o catálogo não mudam.</p>'
        + '<label>Início <input type="time" name="hora" required value="' + H.horaDe(o.inicio_planejado) + '"></label>'
        + '<label>Duração <input name="dur" required inputmode="numeric" value="'
        + H.duracaoEditavel(o.duracao_planejada_seg) + '"><small>min ou min:seg</small></label>');
      if (!f) return;
      const dur = H.lerDuracao(f.get('dur'));
      if (!(dur > 0)) throw new Error('Duração inválida. Use minutos (15) ou min:seg (1:30).');
      patch = { inicio_planejado: H.instante(o.data, H.horaParaSeg(f.get('hora'))), duracao_planejada_seg: dur };
    } else if (acao === 'desfazer') {
      patch = { status: 'agendada' };
    }
    if (!patch) return;
    const atualizada = await D.atualizarOcorrencia(o.id, patch);
    toast('Registro atualizado.');
    renderizar();
    // Google Agenda: concluir marca ✓ no evento; desfazer a conclusão tira o ✓ (em segundo plano, sem travar a tela)
    if (atualizada.gcal_event_id && patch.status && (patch.status === 'concluida' || o.status === 'concluida')) {
      A.conexao.googleReconciliar().catch(function () {
        toast('Registro salvo, mas o Google Agenda não pôde ser atualizado agora. Será refeito à meia-noite.', true);
      });
    }
  }

  conteudo.addEventListener('click', function (ev) {
    const b = ev.target.closest('[data-acao]');
    if (!b || !ocCache[b.dataset.id]) return;
    executarAcao(b.dataset.acao, ocCache[b.dataset.id]).catch(function (e) { toast(e.message, true); });
  });

  // ---------- Painel ----------
  async function telaPainel() {
    const hoje = H.hojeIso(), agora = Date.now();
    const doDia = await D.listarOcorrencias(hoje, hoje);
    const semana = await D.listarOcorrencias(H.somarDias(hoje, -6), hoje);
    const validas = doDia.filter(function (o) { return o.status !== 'cancelada'; });
    const feitas = validas.filter(function (o) { return o.status === 'concluida'; }).length;
    const andamento = doDia.filter(function (o) { return o.status === 'em_andamento'; });
    const proximas = doDia.filter(function (o) { return o.status === 'agendada' && o.fim_planejado >= agora; });
    const atrasadas = doDia.filter(function (o) { return o.status === 'agendada' && o.fim_planejado < agora; });
    const ind = I.calcular(semana, D.TOLERANCIA_PONTUALIDADE_MIN);
    const foco = andamento[0] || proximas[0];
    const outras = proximas.filter(function (o) { return o !== foco; });
    const progresso = validas.length ? feitas / validas.length : 0;

    let focoHtml;
    if (!foco) {
      focoHtml = '<p class="vazio">Nada mais planejado para hoje.</p>';
    } else {
      const falta = Math.round((foco.inicio_planejado - agora) / 60000);
      const quando = foco.status === 'em_andamento' ? 'Em andamento'
        : falta > 0 ? 'Começa em ' + (falta >= 60 ? H.duracaoTexto(falta * 60) : falta + ' min') : 'Deveria ter começado';
      focoHtml = '<p class="destaque-quando">' + quando + '</p><ul class="lista-oc">' + linhaOcorrencia(foco) + '</ul>';
    }

    return '<h1 class="titulo-pagina">' + esc(H.dataExtensa(hoje)) + '</h1>'
      + '<div class="grade-painel">'
      + '<section class="cartao"><h2>Hoje</h2>'
      + '<p class="numero-grande">' + feitas + '<span> de ' + validas.length + '</span></p>'
      + '<div class="barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'
      + Math.round(progresso * 100) + '"><span style="width:' + (progresso * 100) + '%"></span></div>'
      + '<p class="ajuda">concluídas · ' + plural(proximas.length, 'pendente à frente', 'pendentes à frente')
      + (andamento.length ? ' · ' + andamento.length + ' em andamento' : '') + '</p>'
      + '<a class="btn" href="#execucao">Abrir execução do dia</a></section>'
      + '<section class="cartao foco"><h2>Agora</h2>' + focoHtml + '</section>'
      + '</div>'
      + (atrasadas.length ? '<section class="cartao alerta"><h2>Pendências <span class="contador">' + atrasadas.length + '</span></h2>'
        + '<p class="ajuda">Horário já passou e ainda não há registro. Se nada for registrado, viram “não realizada” à meia-noite.</p>'
        + '<ul class="lista-oc">' + atrasadas.map(function (o) { return linhaOcorrencia(o); }).join('') + '</ul></section>' : '')
      + '<section class="cartao"><h2>Próximas</h2>'
      + (outras.length
        ? '<ul class="lista-oc">' + outras.slice(0, 5).map(function (o) { return linhaOcorrencia(o, true); }).join('') + '</ul>'
        : '<p class="vazio">Sem outras atividades hoje.</p>') + '</section>'
      + '<section class="cartao"><h2>Últimos 7 dias</h2><div class="kpis">'
      + kpi('Taxa de conclusão', pct(ind.taxa), ind.concluidas + ' de ' + ind.base + ' (sem canceladas)')
      + kpi('Não realizadas', ind.naoRealizadas, ind.naoRealizadasAuto + ' marcadas automaticamente')
      + kpi('Pontualidade', pct(ind.pontualidade), 'início até ' + D.TOLERANCIA_PONTUALIDADE_MIN + ' min após o previsto · base ' + ind.comInicio)
      + '</div><a class="link" href="#analises">Ver análises</a></section>'
      + '<section class="cartao google" id="google-card"><h2>Google Agenda</h2><p class="ajuda">Verificando…</p></section>';
  }

  function kpi(rotulo, valor, detalhe) {
    return '<div class="kpi"><span class="kpi-rotulo">' + esc(rotulo) + '</span><span class="kpi-valor">'
      + esc(valor) + '</span><span class="kpi-detalhe">' + esc(detalhe) + '</span></div>';
  }

  // ---------- Google Agenda (cartão do Painel) ----------
  let janelaGoogle = null;
  let googleAtivo = false;   // há uma conta do Google conectada? (só então o site chama a função do Google)

  /**
   * Depois de salvar/excluir uma programação, mantém o Google Agenda em dia, em segundo plano:
   *  - 'hoje': data específica para o MESMO DIA => o evento é criado na hora;
   *  - 'limpar': remove do Google os eventos das atividades que foram substituídas ou excluídas.
   */
  function googleEmSegundoPlano(acao) {
    if (!googleAtivo) return;
    const chamada = acao === 'hoje' ? A.conexao.googleCriarHoje() : A.conexao.googleReconciliar();
    chamada.then(function (r) {
      const x = r.resultados && r.resultados[0];
      if (x && x.aviso) console.warn('Google Agenda:', x.aviso);
      if (acao === 'hoje' && x && x.criados) toast(plural(x.criados, 'evento criado', 'eventos criados') + ' no Google Agenda.' + (x.aviso ? ' Atenção: ' + x.aviso : ''), !!(x && x.aviso));
      else if (x && x.erros && x.detalhe) toast('Google Agenda: ' + x.detalhe, true);
      else if (x && x.aviso) toast('Google Agenda: ' + x.aviso, true);
    }).catch(function (e) {
      console.error('Google Agenda:', e);
      toast('Salvo, mas o Google Agenda não respondeu como esperado: ' + (e && e.message ? e.message : e) + ' (será refeito à meia-noite).', true);
    });
  }

  function textoExecucao(e) {
    if (!e) return 'Ainda não houve nenhuma criação de eventos.';
    const quando = new Date(e.executado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return 'Última criação: ' + quando + ' (' + (e.origem === 'manual' ? 'manual' : 'automática') + ') para ' + fmtData(e.data_alvo) + ' — '
      + plural(e.criados, 'evento criado', 'eventos criados') + (e.existentes ? ', ' + e.existentes + ' já existiam' : '')
      + (e.erros ? ', ' + plural(e.erros, 'erro', 'erros') : '') + '.';
  }

  function textoLimpeza(l) {
    if (!l) return null;
    const quando = new Date(l.executado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return 'Última atualização do Google: ' + quando + ' — ' + plural(l.marcados, 'evento marcado', 'eventos marcados') + ' com ✓, '
      + plural(l.removidos, 'evento não concluído removido', 'eventos não concluídos removidos') + (l.erros ? ', ' + plural(l.erros, 'erro', 'erros') : '') + '.';
  }
  const REGRAS_GOOGLE = 'Todos os dias às 23:00, as atividades do <strong>dia seguinte</strong> são criadas na agenda “Rotina”; '
    + 'uma <strong>data específica</strong> criada para o <strong>mesmo dia</strong> vai para o Google na hora. Cada evento avisa antes (conforme o lembrete) e no momento do evento. '
    + 'Ao <strong>concluir</strong> uma atividade no site, o evento recebe ✓ e fica cinza. '
    + 'À meia-noite, os eventos do dia que <strong>não foram concluídos</strong> são excluídos do Google Agenda.';

  async function desenharGoogle() {
    const alvo = $('#google-card');
    if (!alvo) return;
    let s;
    try { s = await A.conexao.googleStatus(); googleAtivo = !!s.conectado; }
    catch (e) { alvo.innerHTML = '<h2>Google Agenda</h2><p class="ajuda">Não foi possível ler a situação: ' + esc(e.message) + '</p>'; return; }
    if (!$('#google-card')) return;
    if (!s.conectado) {
      alvo.innerHTML = '<h2>Google Agenda</h2><p class="ajuda">' + REGRAS_GOOGLE + ' Os lembretes configurados vão junto.</p>'
        + '<div class="botoes"><button type="button" class="btn primario" data-g="conectar">Conectar Google Agenda</button></div>';
    } else {
      alvo.innerHTML = '<h2>Google Agenda <span class="chip st-ok">● Conectado</span></h2>'
        + '<p class="ajuda">Conta: <strong>' + esc(s.email || '—') + '</strong>.</p><p class="ajuda">' + REGRAS_GOOGLE + '</p>'
        + '<p class="ajuda">' + esc(textoExecucao(s.ultima_execucao)) + '</p>'
        + (s.ultima_limpeza ? '<p class="ajuda">' + esc(textoLimpeza(s.ultima_limpeza)) + '</p>' : '')
        + (s.ultimo_erro ? '<p class="erro-login">⚠ ' + esc(s.ultimo_erro) + '</p>' : '')
        + '<div class="botoes"><button type="button" class="btn" data-g="sincronizar">Criar agora os eventos de amanhã</button>'
        + '<button type="button" class="btn" data-g="desconectar">Desconectar</button></div>';
    }
  }

  async function acaoGoogle(acao, botao) {
    botao.disabled = true;
    try {
      if (acao === 'conectar') {
        const url = await A.conexao.googleUrlDeConexao();
        janelaGoogle = window.open(url, 'agenda-google', 'width=520,height=720');
        if (!janelaGoogle) { toast('O navegador bloqueou a janela. Permita pop-ups e tente de novo.', true); return; }
        const espera = setInterval(function () {   // se a janela for fechada, atualiza a situação
          if (!janelaGoogle || janelaGoogle.closed) { clearInterval(espera); desenharGoogle(); }
        }, 800);
      } else if (acao === 'sincronizar') {
        const r = await A.conexao.googleSincronizar();
        const x = r.resultados && r.resultados[0];
        toast(x ? (x.erros ? 'Concluído com ' + plural(x.erros, 'erro', 'erros') + '. ' : '') + plural(x.criados, 'evento criado', 'eventos criados') + ' para amanhã.' : 'Nada a criar.', !!(x && x.erros));
        await desenharGoogle();
      } else if (acao === 'desconectar') {
        if (!confirm('Desconectar o Google Agenda? Os eventos já criados continuam na agenda “Rotina”, mas novos não serão criados.')) return;
        await A.conexao.googleDesconectar();
        toast('Google Agenda desconectado.');
        await desenharGoogle();
      }
    } catch (e) { toast(e.message, true); }
    finally { botao.disabled = false; }
  }

  function aposPainel() {
    const card = $('#google-card');
    if (!card) return;
    card.addEventListener('click', function (e) {
      const b = e.target.closest('[data-g]');
      if (b) acaoGoogle(b.dataset.g, b);
    });
    desenharGoogle();
  }
  window.addEventListener('message', function (e) {   // a janela do Google avisa quando termina
    if (e.data && e.data.tipo === 'agenda-google' && janelaGoogle && e.source === janelaGoogle) {
      toast(e.data.ok ? 'Google Agenda conectado.' : 'Não foi possível conectar o Google Agenda.', !e.data.ok);
      desenharGoogle();
    }
  });

  // ---------- Execução diária ----------
  async function telaExecucao(p) {
    const hoje = H.hojeIso();
    const data = /^\d{4}-\d{2}-\d{2}$/.test(p.data || '') ? p.data : hoje;
    const ocs = await D.listarOcorrencias(data, data);
    const ind = I.calcular(ocs);
    const rel = data === hoje ? 'Hoje' : data < hoje ? 'Dia passado' : 'Dia futuro';
    return '<div class="cabecalho-tela"><h1 class="titulo-pagina">' + esc(H.dataExtensa(data))
      + ' <small>' + rel + '</small></h1>'
      + '<div class="nav-data">'
      + '<a class="btn" href="#execucao?data=' + H.somarDias(data, -1) + '" aria-label="Dia anterior">←</a>'
      + '<input type="date" id="exec-data" value="' + data + '" aria-label="Escolher data">'
      + '<a class="btn" href="#execucao?data=' + H.somarDias(data, 1) + '" aria-label="Próximo dia">→</a>'
      + (data !== hoje ? '<a class="btn" href="#execucao">Hoje</a>' : '')
      + '<button type="button" class="btn" id="btn-avulsa">+ Atividade avulsa</button></div></div>'
      + '<p class="resumo">' + plural(ocs.length, 'atividade', 'atividades') + ' · ' + ind.concluidas + ' concluídas · '
      + ind.naoRealizadas + ' não realizadas · ' + ind.canceladas + ' canceladas</p>'
      + (data > hoje ? '<p class="ajuda">Dia futuro: só é possível ajustar ou cancelar.</p>' : '')
      + (ocs.length ? '<ul class="lista-oc">' + ocs.map(function (o) { return linhaOcorrencia(o); }).join('') + '</ul>'
        : '<p class="vazio">Nenhuma atividade para este dia. Crie um modelo em <a href="#planejamento">Planejamento</a> ou adicione uma atividade avulsa.</p>');
  }

  function aposExecucao(p) {
    const inp = $('#exec-data');
    inp.addEventListener('change', function () { if (inp.value) location.hash = '#execucao?data=' + inp.value; });
    $('#btn-avulsa').addEventListener('click', function () {
      adicionarAvulsa(inp.value).catch(function (e) { toast(e.message, true); });
    });
  }

  function opcoesCatalogo(selecionada) {
    const grupos = {};
    catalogo.filter(function (c) { return c.planejavel; }).forEach(function (c) {
      const g = c.tipo === 'rotina' ? 'Rotinas' : c.area + ' (' + c.categoria + ')';
      (grupos[g] = grupos[g] || []).push(c);
    });
    return Object.keys(grupos).map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + grupos[g].map(function (c) {
        return '<option value="' + chaveCat(c) + '"' + (chaveCat(c) === selecionada ? ' selected' : '') + '>'
          + esc(c.titulo) + ' — ' + H.duracaoTexto(c.duracao_segundos) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  async function adicionarAvulsa(data) {
    const f = await abrirModal('Atividade avulsa em ' + H.dataCurta(data),
      '<label>Atividade <select name="cat" required><option value="">Escolha…</option>' + opcoesCatalogo() + '</select></label>'
      + '<label>Início <input type="time" name="hora" required value="' + H.horaDe(Date.now()) + '"></label>'
      + '<label>Duração <input name="dur" inputmode="numeric" placeholder="vazio = duração do catálogo"><small>min ou min:seg</small></label>',
      'Adicionar');
    if (!f) return;
    const c = buscarCat(f.get('cat'));
    const dur = H.lerDuracao(f.get('dur'));
    if (Number.isNaN(dur) || dur === 0) throw new Error('Duração inválida.');
    await D.criarAvulsa({ data: data, tipo: c.tipo, id_origem: c.id_origem,
      inicioSeg: H.horaParaSeg(f.get('hora')), duracao: dur });
    toast('Atividade adicionada.');
    renderizar();
  }

  // ---------- Planejamento (editor de modelo) ----------
  let rascunho = null, rascunhoSujo = false, rascunhoAlvo = null;
  let filtroCat = { texto: '', grupo: '' };

  /** 'data' (programação de uma data específica, o padrão) ou 'modelo' (repete conforme uma regra). */
  function modeloNovo(tipo) {
    const hoje = H.hojeIso();
    const novo = { id: null, nome: '', hora_inicio: '18:00', intervalo_dias: null, dias_semana: [H.diaSemana(hoje)],
      data_inicio: hoje, data_fim: null, ativo: true, lembrete_minutos: 5, descricao: '', itens: [] };
    if (tipo === 'modelo') novo.recorrencia = 'semanal';
    else { novo.recorrencia = 'unica'; novo.data_fim = hoje; novo.hora_inicio = horaPadraoHoje(); }   // data específica de hoje: agora + 5 min
    return novo;
  }
  /** Hora atual ('HH:MM', arredondada para cima ao minuto). */
  function horaAgora() {
    const d = new Date();
    const min = d.getHours() * 60 + d.getMinutes() + (d.getSeconds() || d.getMilliseconds() ? 1 : 0);
    return H.segParaHora(Math.min(min, 23 * 60 + 59) * 60);
  }
  /** Início sugerido para uma data específica de hoje: agora + 5 min (no máximo 23:59). */
  function horaPadraoHoje() {
    const d = new Date();
    return H.segParaHora(Math.min(d.getHours() * 60 + d.getMinutes() + 5, 23 * 60 + 59) * 60);
  }
  /** Data e início salvos da data específica em edição: só exige início >= agora quando são alterados. */
  let inicioSalvo = null;
  /** Início preenchido automaticamente (agora + 5 min) e ainda não editado; null se não houver. */
  let horaAuto = null;
  function exigeInicioFuturo(m) {
    return ehData(m) && m.data_inicio === H.hojeIso()
      && !(inicioSalvo && inicioSalvo.data === m.data_inicio && inicioSalvo.hora === m.hora_inicio);
  }
  function ehData(m) { return H.tipoRecorrencia(m) === 'unica'; }
  const INTERVALOS_FIXOS = [20, 30, 90];
  const SUGESTOES_DURACAO = [300, 600, 1200, 1800, 2400, 3000];   // 5, 10, 20, 30, 40 e 50 min
  /** Opção do seletor de duração da data específica: 'padrao' (15 min), uma sugestão ou 'outra' (personalizar). */
  function opcaoDuracao(seg) {
    if (seg == null) return 'padrao';
    return SUGESTOES_DURACAO.indexOf(seg) !== -1 ? String(seg) : 'outra';
  }
  /** Opção do seletor "Repetição" que representa o modelo. */
  function opcaoRec(m) {
    const t = H.tipoRecorrencia(m);
    if (t !== 'intervalo') return t;
    return INTERVALOS_FIXOS.indexOf(m.intervalo_dias) !== -1 ? 'i' + m.intervalo_dias : 'icustom';
  }
  const OPCOES_REC = [
    ['diaria', 'Repetir todos os dias'],
    ['semanal', 'Repetir em dias específicos'],
    ['i20', 'A cada 20 dias'],
    ['i30', 'A cada 30 dias'],
    ['i90', 'A cada 90 dias'],
    ['icustom', 'A cada outro número de dias…'],
  ];

  async function telaPlanejamento(p) {
    await D.recarregar();
    const modelos = await D.listarModelos();
    const hoje = H.hojeIso();
    // padrão: nova programação de data específica; "tipo=modelo" abre um novo modelo
    let alvo = !p.modelo || p.modelo === 'novo' ? 'novo:' + (p.tipo === 'modelo' ? 'modelo' : 'data') : p.modelo;
    const salvo = modelos.find(function (x) { return x.id === alvo; });
    if (!salvo && alvo.indexOf('novo:') !== 0) alvo = 'novo:data';
    if (!rascunho || rascunhoAlvo !== alvo) {
      rascunho = salvo ? JSON.parse(JSON.stringify(salvo)) : modeloNovo(alvo === 'novo:modelo' ? 'modelo' : 'data');
      if (ehData(rascunho)) rascunho.ativo = true;
      inicioSalvo = salvo ? { data: salvo.data_inicio, hora: salvo.hora_inicio } : null;
      horaAuto = salvo ? null : rascunho.hora_inicio;
      rascunhoAlvo = alvo;
      rascunhoSujo = false;
    }
    const r = rascunho, op = opcaoRec(r), data = ehData(r);
    const opcao = function (m) {
      return '<option value="' + m.id + '"' + (m.id === r.id ? ' selected' : '') + '>'
        + (ehData(m) ? H.dataCurta(m.data_inicio) + ' · ' : '') + esc(m.nome) + (m.ativo ? '' : ' (inativo)') + '</option>';
    };
    const datas = modelos.filter(function (m) { return ehData(m) && (m.data_inicio >= hoje || m.id === r.id); })
      .sort(function (x, y) { return x.data_inicio < y.data_inicio ? -1 : x.data_inicio > y.data_inicio ? 1 : 0; });
    const recorrentes = modelos.filter(function (m) { return !ehData(m); });
    const seletor = '<optgroup label="Novo"><option value="novo"' + (!r.id && data ? ' selected' : '') + '>+ Nova data específica</option>'
      + '<option value="novo-modelo"' + (!r.id && !data ? ' selected' : '') + '>+ Novo modelo</option></optgroup>'
      + (datas.length ? '<optgroup label="Datas específicas">' + datas.map(opcao).join('') + '</optgroup>' : '')
      + (recorrentes.length ? '<optgroup label="Modelos">' + recorrentes.map(opcao).join('') + '</optgroup>' : '');
    const grupos = ['Rotina'].concat(Array.from(new Set(catalogo.filter(function (c) { return c.area; })
      .map(function (c) { return c.categoria; }))));

    const lembrete = '<label>Lembrete <span class="com-sufixo"><input type="number" id="pl-lembrete" min="0" max="240" value="'
      + (r.lembrete_minutos == null ? '' : r.lembrete_minutos) + '"> min antes</span></label>';
    const ativo = '<label class="check"><input type="checkbox" id="pl-ativo"' + (r.ativo ? ' checked' : '') + '> Ativo</label>';
    const inicio = '<label>Início da sequência <input type="time" id="pl-inicio" value="' + esc(r.hora_inicio || '') + '">'
      + '<small>opcional se a 1ª atividade tiver início próprio</small></label>';
    const camposTopo = data
      ? '<div class="form-grade data-especifica">'
        + '<label class="campo-nome">Nome <input id="pl-nome" value="' + esc(r.nome) + '" placeholder="Ex.: Consulta médica" maxlength="80">'
        + '<small id="pl-nome-dica"></small></label>'
        + '<label>Início da atividade <input type="time" id="pl-inicio" value="' + esc(r.hora_inicio || '') + '"'
        + (exigeInicioFuturo(r) ? ' min="' + horaAgora() + '"' : '') + '>'
        + '<small>obrigatório · não pode ser 00:00 · hoje, a partir de agora</small></label>'
        + '<label id="campo-dur-livre"' + (r.itens.length ? ' hidden' : '') + '>Duração <select id="pl-dur-sel">'
        + '<option value="padrao">15 min (padrão)</option>'
        + SUGESTOES_DURACAO.map(function (s) { return '<option value="' + s + '">' + (s / 60) + ' min</option>'; }).join('')
        + '<option value="outra">Personalizar…</option></select>'
        + '<input id="pl-dur-livre" inputmode="numeric" placeholder="min ou min:seg" value="' + esc(H.duracaoEditavel(r.duracao_livre_seg)) + '"'
        + (opcaoDuracao(r.duracao_livre_seg) === 'outra' ? '' : ' hidden') + '>'
        + '<small>da atividade com este nome</small></label>'
        + '<label>Data <input type="date" id="pl-data" value="' + esc(r.data_inicio || '') + '" min="' + hoje + '" required>'
        + '<small id="pl-data-dia">' + esc(r.data_inicio ? H.dataExtensa(r.data_inicio) : '') + '</small></label>'
        + lembrete.replace('<label>Lembrete', '<label class="campo-lembrete">Lembrete')
        + '<div class="campo-descricao"><span class="rotulo">Descrição</span>'
        + '<div class="desc-linha"><span id="pl-desc-resumo" class="desc-resumo"></span>'
        + '<button type="button" class="btn pequeno" id="pl-desc-editar">Editar descrição</button></div>'
        + '<small>texto formatado ou link do Google Docs · aparece no botão Descrição da tela Execução</small></div></div>'
      : '<div class="form-grade">'
        + '<label>Nome do modelo <input id="pl-nome" value="' + esc(r.nome) + '" placeholder="Ex.: Manhã" maxlength="80" required></label>'
        + inicio + lembrete + ativo + '</div>'
        + '<fieldset class="recorrencia"><legend>Quando</legend>'
        + '<p class="ajuda">Vale para <strong>todas as atividades deste modelo</strong>. Para uma frequência diferente, crie outro modelo.</p>'
        + '<label>Repetição <select id="pl-rec">' + OPCOES_REC.map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === op ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></label>'
        + '<div id="rec-semanal"' + (op === 'semanal' ? '' : ' hidden') + '><div class="dias">'
        + [1, 2, 3, 4, 5, 6, 7].map(function (d) {
          return '<label class="dia"><input type="checkbox" value="' + d + '"' + ((r.dias_semana || []).indexOf(d) !== -1 ? ' checked' : '')
            + '><span>' + H.NOMES_DIA[d] + '</span></label>';
        }).join('') + '</div></div>'
        + '<div id="rec-intervalo"' + (op === 'icustom' ? '' : ' hidden') + '><label>Repetir a cada <span class="com-sufixo">'
        + '<input type="number" id="pl-intervalo" min="1" max="365" value="' + (r.intervalo_dias || '') + '"> dias</span></label></div>'
        + '<p class="ajuda" id="rec-ajuda-intervalo"' + (op.charAt(0) === 'i' ? '' : ' hidden')
        + '>Os dias são contados a partir de <strong>' + esc(r.data_inicio ? fmtData(r.data_inicio) : 'hoje')
        + '</strong> (data em que o modelo começou): esse é o 1º dia e depois repete no intervalo escolhido.</p>'
        + '<p class="ajuda" id="rec-previa"></p>'
        + '</fieldset>';

    return '<div class="cabecalho-tela"><h1 class="titulo-pagina">Planejamento</h1>'
      + '<div class="nav-data"><label class="inline">Programação <select id="pl-modelo">' + seletor + '</select></label></div></div>'
      + '<div class="planejamento">'
      // Catálogo
      + '<section class="cartao catalogo"><h2>Catálogo</h2>'
      + '<div class="filtros"><input type="search" id="cat-busca" placeholder="Buscar atividade" value="' + esc(filtroCat.texto) + '">'
      + '<select id="cat-grupo"><option value="">Todas</option>' + grupos.map(function (g) {
        return '<option' + (g === filtroCat.grupo ? ' selected' : '') + '>' + esc(g) + '</option>';
      }).join('') + '</select></div>'
      + '<div id="cat-lista" class="cat-lista"></div>'
      + '<p class="ajuda">Itens com duração 0 são títulos de grupo e não podem ser planejados.</p></section>'
      // Sequência
      + '<section class="cartao sequencia"><h2>Sequência</h2>'
      + '<div class="tipo-plano"><div class="segmentado" role="group" aria-label="Tipo de planejamento">'
      + '<button type="button" data-tipo="data" aria-pressed="' + data + '">Data específica</button>'
      + '<button type="button" data-tipo="modelo" aria-pressed="' + !data + '">Modelo (repete)</button></div>'
      + '<p class="ajuda">' + (data ? 'Planeja um único dia. Para repetir esta programação, altere para Modelo.'
        : 'Repete conforme a regra em Quando. Para planejar um único dia, altere para Data específica.') + '</p></div>'
      + camposTopo
      + '<ol id="seq-lista" class="seq-lista"></ol>'
      + '<div class="seq-rodape"><p id="seq-total" class="seq-total"></p>'
      + '<p class="ajuda">Ao salvar, as ocorrências futuras ainda não iniciadas são recalculadas. Registros já feitos, ajustes manuais e o histórico não mudam. A duração do catálogo nunca é alterada.</p>'
      + '<div class="botoes"><button type="button" class="btn" id="pl-descartar">Descartar alterações</button>'
      + '<button type="button" class="btn primario" id="pl-salvar">' + (data ? 'Salvar na data' : 'Salvar modelo') + '</button></div></div>'
      + '</section></div>'
      + '<section class="cartao previa" id="previa" aria-label="Prévia da programação"></section>';
  }

  function renderCatalogo() {
    const txt = filtroCat.texto.trim().toLowerCase();
    const lista = catalogo.filter(function (c) {
      return (!filtroCat.grupo || c.categoria === filtroCat.grupo)
        && (!txt || c.titulo.toLowerCase().indexOf(txt) !== -1 || (c.area || '').toLowerCase().indexOf(txt) !== -1);
    });
    let html = '', grupoAtual = null;
    lista.forEach(function (c) {
      const g = c.tipo === 'rotina' ? 'Rotinas' : c.area;
      if (g !== grupoAtual) {
        html += '<div class="cat-grupo">' + esc(g) + (c.tipo === 'rotina' ? '' : ' <small>' + esc(c.categoria) + '</small>') + '</div>';
        grupoAtual = g;
      }
      html += c.planejavel
        ? '<div class="cat-item"><button type="button" class="cat-add" data-add="' + chaveCat(c) + '"><span>' + esc(c.titulo)
          + '</span><span class="cat-dur">' + H.duracaoTexto(c.duracao_segundos) + '</span><span class="mais" aria-hidden="true">+</span></button>'
          + '</div>'
        : '<div class="cat-item cabecalho" title="Título de grupo (duração 0)">' + esc(c.titulo) + '</div>';
    });
    $('#cat-lista').innerHTML = html || '<p class="vazio">Nada encontrado.</p>';
  }

  function duracaoCatalogoDe(it) {
    const c = D.itemCatalogo(it); return c ? c.duracao_segundos : 0;
  }

  /** 'HH:MM' (ou 'HH:MM:SS') para o campo de hora; vazio se não houver horário. */
  function valorHora(seg) {
    if (seg == null) return '';
    const s = ((Math.round(seg) % 86400) + 86400) % 86400;
    const p = function (n) { return String(n).padStart(2, '0'); };
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + (s % 60 ? ':' + p(s % 60) : '');
  }

  /** Campos da data específica que dependem de haver (ou não) atividades do catálogo. */
  function atualizarCamposData() {
    const campo = $('#campo-dur-livre');
    if (campo) campo.hidden = rascunho.itens.length > 0;
    const dica = $('#pl-nome-dica');
    if (dica) dica.textContent = rascunho.itens.length ? 'opcional com atividades do catálogo' : 'obrigatório sem atividades do catálogo';
  }

  function renderSequencia() {
    const r = rascunho;
    atualizarCamposData();
    if (!r.itens.length) {
      $('#seq-lista').innerHTML = '<li class="vazio">' + (ehData(r)
        ? 'Opcional: escolha atividades no catálogo. Sem escolher, será criada uma atividade com o nome informado.'
        : 'Escolha atividades no catálogo para montar a sequência.') + '</li>';
      atualizarHorarios();
      return;
    }
    $('#seq-lista').innerHTML = r.itens.map(function (it, i) {
      const c = D.itemCatalogo(it);
      return '<li class="seq-item" data-i="' + i + '">'
        + '<div class="seq-hora"><input type="time" class="hora-inicio" data-campo="inicio" data-i="' + i + '"'
        + ' aria-label="Início da atividade (clique para alterar)" title="Clique para alterar o horário de início">'
        + '<span data-fim="' + i + '"></span><em class="conflito" data-aviso="' + i + '" hidden>início ignorado</em></div>'
        + '<div class="seq-titulo">' + esc(c ? c.titulo : 'Atividade removida do catálogo')
        + '<small>' + (it.tipo === 'livre' ? 'atividade própria' : c ? '<button type="button" class="link" data-focar="' + i + '" title="Alterar a duração só nesta programação">catálogo: '
          + H.duracaoTexto(c.duracao_segundos) + '</button>' : 'sem duração no catálogo') + (c && c.area ? ' · ' + esc(c.area) : '')
        + ' · <span data-dica="' + i + '"></span></small></div>'
        + '<div class="seq-campos">'
        + '<label>Duração <input data-campo="dur" data-i="' + i + '" inputmode="numeric" placeholder="min ou min:seg">'
        + '<small data-nota-dur="' + i + '"></small></label>'
        + '<label>Intervalo antes <input data-campo="int" data-i="' + i + '" inputmode="numeric" placeholder="0" value="'
        + (it.intervalo_antes_seg ? H.duracaoEditavel(it.intervalo_antes_seg) : '') + '"></label>'
        + '</div>'
        + '<div class="seq-mover">'
        + '<button type="button" class="btn icone" data-mover="-1" data-i="' + i + '" aria-label="Subir"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button type="button" class="btn icone" data-mover="1" data-i="' + i + '" aria-label="Descer"' + (i === r.itens.length - 1 ? ' disabled' : '') + '>↓</button>'
        + '<button type="button" class="btn icone" data-remover="' + i + '" aria-label="Remover">✕</button>'
        + '</div></li>';
    }).join('');
    atualizarHorarios();
  }

  /** Recalcula e redesenha horários, dicas e valores. Campos que estão sendo digitados não são sobrescritos. */
  function atualizarHorarios() {
    const r = rascunho;
    const total = $('#seq-total');
    if (!r.itens.length) {
      if (ehData(r)) {   // atividade própria: só o nome
        const ini = H.horaParaSeg(r.hora_inicio), dur = r.duracao_livre_seg || D.DURACAO_LIVRE_PADRAO_SEG;
        total.innerHTML = ini == null ? 'Defina o horário de início da atividade.'
          : '<strong>' + H.segParaHora(ini) + ' – ' + H.segParaHora(ini + dur) + '</strong> · 1 atividade (' + esc(r.nome.trim() || 'sem nome') + ') · ' + H.duracaoTexto(dur);
      } else total.textContent = '';
      return;
    }
    const semInicio = !r.hora_inicio && !r.itens[0].hora_fixa;
    const seq = H.calcularSequencia(H.horaParaSeg(r.hora_inicio), r.itens, duracaoCatalogoDe);
    const foco = document.activeElement;
    seq.forEach(function (s, i) {
      const it = r.itens[i], c = D.itemCatalogo(it);
      const q = function (sel) { return document.querySelector(sel + '[data-i="' + i + '"]'); };
      const campoInicio = q('[data-campo="inicio"]'), campoDur = q('[data-campo="dur"]');
      if (campoInicio && campoInicio !== foco) campoInicio.value = i === 0 && semInicio ? '' : valorHora(s.inicio);
      document.querySelector('[data-fim="' + i + '"]').textContent = i === 0 && semInicio ? '' : H.segParaHora(s.fim);
      document.querySelector('[data-aviso="' + i + '"]').hidden = !s.conflito;
      // início: automático ou definido
      document.querySelector('[data-dica="' + i + '"]').innerHTML = i === 0
        ? (semInicio ? 'defina o início' : ehData(r) ? 'início da atividade' : 'início da sequência')
        : (it.hora_fixa ? 'início definido · <button type="button" class="link" data-limpar="' + i + '">usar automático</button>' : 'início automático');
      // duração: sempre mostra o valor em uso; só vira "própria" quando difere do catálogo
      const noCat = c ? c.duracao_segundos : 0;
      const livre = it.tipo === 'livre';
      const propria = !livre && it.duracao_personalizada_seg != null;
      if (campoDur && campoDur !== foco && campoDur.getAttribute('aria-invalid') !== 'true') {
        campoDur.value = H.duracaoEditavel(propria ? it.duracao_personalizada_seg : noCat);
      }
      document.querySelector('[data-nota-dur="' + i + '"]').innerHTML = livre
        ? 'atividade própria · em branco = ' + H.duracaoTexto(D.DURACAO_LIVRE_PADRAO_SEG)
        : propria
        ? 'alterada só nesta programação · <button type="button" class="link" data-restaurar="' + i + '">usar a do catálogo</button>'
        : 'do catálogo · edite para mudar só nesta programação';
    });
    if (semInicio) { total.textContent = 'Defina o horário de início da sequência ou da 1ª atividade.'; return; }
    const inicio = seq[0].inicio, fim = seq[seq.length - 1].fim;
    total.innerHTML = '<strong>' + H.segParaHora(inicio) + ' – ' + H.segParaHora(fim) + '</strong> · '
      + plural(r.itens.length, 'atividade', 'atividades') + ' · ' + H.duracaoTexto(fim - inicio) + ' no total';
  }

  // ---------- Conflitos e prévia da programação ----------
  let previaEstado = { modelo: null, data: null, modo: 'dia' };
  let previaTimer = null, previaSeq = 0;

  function fmtData(iso) {
    const p = iso.split('-');
    return H.NOMES_DIA[H.diaSemana(iso)] + ', ' + p[2] + '/' + p[1] + '/' + p[0];
  }
  /** Primeira data a partir de `apartir` em que o modelo gera atividades (hoje se nenhuma em 2 anos). */
  function proximaOcorrencia(m, apartir) {
    const inicio = apartir || H.hojeIso();
    let d = inicio;
    for (let i = 0; i < 800; i++, d = H.somarDias(d, 1)) if (H.valeNoDia(m, d)) return d;
    return inicio;
  }
  function descreveItem(x, proprio) {
    return H.horaDe(x.inicio) + '–' + H.horaDe(x.fim) + ' «' + esc(x.titulo) + '» ('
      + (proprio ? 'esta programação' : x.avulsa ? 'atividade avulsa' : 'programação «' + esc(x.modelo_nome) + '»') + ')';
  }
  function textoConflito(cf) {
    return '<strong>' + fmtData(cf.data) + '</strong> · ' + descreveItem(cf.a, true) + ' × ' + descreveItem(cf.b, false);
  }

  /** Lista os conflitos (data, horário e atividade) em uma janela. Devolve true se o usuário escolheu o botão de ação. */
  async function modalConflitos(c, titulo, intro, okTexto) {
    const mostrados = c.lista.slice(0, 8);
    const mais = c.total - mostrados.length;
    const f = await abrirModal(titulo,
      '<p class="ajuda">' + intro + '</p><ul class="conflitos">'
      + mostrados.map(function (cf) { return '<li>' + textoConflito(cf) + '</li>'; }).join('') + '</ul>'
      + (mais > 0 ? '<p class="ajuda">+ ' + plural(mais, 'outra sobreposição', 'outras sobreposições')
        + (c.truncado ? ' (lista parcial: mostrando as primeiras)' : '') + '.</p>' : ''), okTexto);
    return !!f;
  }
  async function verConflitosNaPrevia(c) {
    const ir = await modalConflitos(c, 'Conflito de horários: a programação não foi salva',
      'Esta programação se sobrepõe a outras atividades. Ajuste os horários ou os dias e salve de novo.', 'Ver na prévia');
    if (ir && c.lista.length) {
      previaEstado.data = c.lista[0].data; previaEstado.modo = 'dia';
      await renderProgramacao();
      const el = $('#previa'); if (el) el.scrollIntoView({ block: 'start' });
    }
  }

  function agendarPrevia() {
    clearTimeout(previaTimer);
    previaTimer = setTimeout(function () { renderProgramacao(); }, 150);
  }

  async function itensDaPrevia(data, nomes) {
    if (data < H.hojeIso()) {   // passado: mostra o que foi realmente registrado
      const ocs = await D.listarOcorrencias(data, data);
      return { passado: true, itens: ocs.map(function (o) {
        return { modelo_id: o.modelo_id, modelo_nome: o.modelo_id ? (nomes[o.modelo_id] || 'Modelo removido') : 'Avulsa',
          titulo: o.titulo_planejado, inicio: o.inicio_planejado, fim: o.fim_planejado, ocorrencia: o, conflitos: [] };
      }) };
    }
    return { passado: false, itens: D.projetarDia(data, rascunho) };
  }

  function linhaPrevia(it, passado, rId) {
    const meu = !passado && it.modelo_id === rId;
    const conflitos = it.conflitos || [];
    return '<li class="prev-item' + (meu ? ' meu' : '') + (conflitos.length ? ' conflito' : '') + '">'
      + '<div class="oc-hora"><strong>' + H.horaDe(it.inicio) + '</strong><span>' + H.horaDe(it.fim) + '</span></div>'
      + '<div class="prev-info"><div class="prev-titulo">' + esc(it.titulo) + ' <span class="etiqueta' + (meu ? ' meu' : '') + '">'
      + (meu ? 'Esta programação' : esc(it.modelo_nome)) + '</span></div>'
      + (conflitos.length ? '<div class="prev-conf"><span aria-hidden="true">⚠</span> Conflita com ' + conflitos.map(function (c) {
        return '«' + esc(c.titulo) + '» (' + (c.avulsa ? 'avulsa' : esc(c.modelo_nome)) + ') ' + H.horaDe(c.inicio) + '–' + H.horaDe(c.fim);
      }).join('; ') + '</div>' : '')
      + '</div>' + (passado ? '<div class="oc-estado">' + chip(it.ocorrencia) + '</div>' : '') + '</li>';
  }

  /** Redesenha a prévia usando o rascunho atual (inclusive alterações ainda não salvas). */
  async function renderProgramacao() {
    const alvo = $('#previa');
    if (!alvo || !rascunho || rotaAtual !== 'planejamento') return;
    const minha = ++previaSeq;
    const rId = rascunho.id || 'novo', hoje = H.hojeIso();
    if (previaEstado.modelo !== rId) previaEstado = { modelo: rId, data: proximaOcorrencia(rascunho), modo: 'dia' };
    const dia = previaEstado.data;
    const dias = [0, 1, 2, 3, 4, 5, 6].map(function (n) { return H.somarDias(inicioSemana(dia), n); });
    const nomes = {};
    (await D.listarModelos()).forEach(function (m) { nomes[m.id] = m.nome; });
    const dados = {};
    await Promise.all(dias.map(async function (d) { dados[d] = await itensDaPrevia(d, nomes); }));
    if (minha !== previaSeq || $('#previa') !== alvo) return;   // chegou resposta mais nova ou a tela mudou

    const conf = D.verificarConflitos(rascunho);
    let resumo;
    if (!rascunho.ativo) resumo = '<div class="previa-resumo">Modelo inativo: não gera programação nem conflitos.</div>';
    else if (!A.projecao.projetavel(D.expandir(rascunho))) resumo = '<div class="previa-resumo">Informe o nome (ou escolha atividades) e defina o início para ver a prévia e checar conflitos.</div>';
    else if (!conf.total) resumo = '<div class="previa-resumo ok"><span aria-hidden="true">✓</span> Sem conflitos de horário com os outros modelos e atividades avulsas nos próximos 2 anos.</div>';
    else resumo = '<div class="previa-resumo alerta"><span aria-hidden="true">⚠</span> <strong>' + plural(conf.total, 'sobreposição', 'sobreposições')
      + '</strong> (somando todos os dias dos próximos 2 anos). Não é possível salvar enquanto houver conflito. A primeira: ' + textoConflito(conf.lista[0])
      + ' <button type="button" class="link" data-ir-conflito>ver na prévia</button></div>';

    const semana = previaEstado.modo === 'semana';
    const chips = dias.map(function (d) {
      const its = dados[d].itens, nConf = its.filter(function (i) { return (i.conflitos || []).length; }).length;
      return '<button type="button" class="dia-chip' + (nConf ? ' tem-conflito' : '') + '" data-dia="' + d + '" aria-pressed="' + (!semana && d === dia)
        + '" title="' + esc(fmtData(d)) + (nConf ? ' · ' + plural(nConf, 'atividade em conflito', 'atividades em conflito') : '') + '">'
        + '<span>' + H.NOMES_DIA[H.diaSemana(d)] + (d === hoje ? ' · hoje' : '') + '</span><span>' + H.dataCurta(d) + '</span>'
        + '<small>' + (nConf ? '⚠ ' + nConf : its.length ? its.length + (its.length === 1 ? ' ativ.' : ' ativ.') : '–') + '</small></button>';
    }).join('');

    function blocoDia(d) {
      const x = dados[d];
      return '<section class="prev-dia">' + (semana ? '<h3>' + esc(fmtData(d)) + (d === hoje ? ' <small>hoje</small>' : '') + '</h3>' : '')
        + (x.passado ? '<p class="ajuda">Dia passado: mostra o que foi registrado, sem alterações desta programação.</p>' : '')
        + (x.itens.length ? '<ul class="lista-prev">' + x.itens.map(function (it) { return linhaPrevia(it, x.passado, rId); }).join('') + '</ul>'
          : '<p class="vazio">Nenhuma atividade prevista' + (semana ? '.' : ' para este dia.') + '</p>') + '</section>';
    }

    alvo.innerHTML = '<div class="cartao-topo"><h2>Prévia da programação</h2>'
      + '<div class="segmentado" role="group" aria-label="Visão"><button type="button" data-modo="dia" aria-pressed="' + !semana + '">Dia</button>'
      + '<button type="button" data-modo="semana" aria-pressed="' + semana + '">Semana</button></div></div>'
      + '<p class="ajuda">Mostra esta programação, <strong>inclusive as alterações ainda não salvas</strong>, junto com os outros modelos ativos e as atividades avulsas.</p>'
      + resumo
      + '<div class="previa-nav"><button type="button" class="btn" data-sem="-1" aria-label="Semana anterior">‹ Semana</button>'
      + '<input type="date" id="previa-data" value="' + dia + '" aria-label="Escolher qualquer data">'
      + '<button type="button" class="btn" data-sem="1" aria-label="Próxima semana">Semana ›</button>'
      + '<button type="button" class="btn" data-hoje>Hoje</button>'
      + '<button type="button" class="btn" data-prox title="Próxima data em que esta programação gera atividades">Próxima desta programação</button></div>'
      + '<div class="previa-dias" role="group" aria-label="Dias da semana">' + chips + '</div>'
      + (semana ? dias.map(blocoDia).join('') : blocoDia(dia));
  }

  function aposPlanejamento() {
    const r = rascunho;
    renderCatalogo();
    renderSequencia();
    function sujar() { rascunhoSujo = true; agendarPrevia(); }

    $('#previa').addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.modo) previaEstado.modo = b.dataset.modo;
      else if (b.dataset.dia) { previaEstado.data = b.dataset.dia; previaEstado.modo = 'dia'; }
      else if (b.dataset.sem) previaEstado.data = H.somarDias(previaEstado.data, 7 * Number(b.dataset.sem));
      else if (b.hasAttribute('data-hoje')) previaEstado.data = H.hojeIso();
      else if (b.hasAttribute('data-prox')) previaEstado.data = proximaOcorrencia(rascunho, H.somarDias(previaEstado.data, 1));
      else if (b.hasAttribute('data-ir-conflito')) {
        const c = D.verificarConflitos(rascunho);
        if (c.lista.length) { previaEstado.data = c.lista[0].data; previaEstado.modo = 'dia'; }
      } else return;
      renderProgramacao();
    });
    $('#previa').addEventListener('change', function (e) {
      if (e.target.id === 'previa-data' && e.target.value) { previaEstado.data = e.target.value; renderProgramacao(); }
    });
    renderProgramacao();

    $('#pl-modelo').addEventListener('change', function (e) {
      if (rascunhoSujo && !confirm('Descartar as alterações não salvas?')) { e.target.value = r.id || (ehData(r) ? 'novo' : 'novo-modelo'); return; }
      rascunho = null; rascunhoSujo = false;
      const destino = e.target.value === 'novo-modelo' ? '#planejamento?modelo=novo&tipo=modelo' : '#planejamento?modelo=' + e.target.value;
      if (location.hash === destino) renderizar(); else location.hash = destino;
    });

    // alterna entre Data específica e Modelo mantendo todas as atividades já montadas
    document.querySelectorAll('[data-tipo]').forEach(function (b) {
      b.addEventListener('click', function () {
        const paraData = b.dataset.tipo === 'data';
        if (paraData === ehData(r)) return;
        const hoje = H.hojeIso();
        if (paraData) {
          const d = r.data_inicio && r.data_inicio >= hoje ? r.data_inicio : hoje;
          r.recorrencia = 'unica'; r.intervalo_dias = null; r.data_inicio = d; r.data_fim = d; r.ativo = true;
          if (d === hoje && (!r.hora_inicio || r.hora_inicio < horaAgora())) r.hora_inicio = horaAuto = horaPadraoHoje();
        } else {
          r.recorrencia = 'semanal'; r.intervalo_dias = null; r.data_fim = null;
          r.dias_semana = [H.diaSemana(r.data_inicio || hoje)];
          r.data_inicio = hoje;   // o modelo começa hoje (não há campo de data inicial)
        }
        previaEstado.modelo = null;   // recalcula a data inicial da prévia
        sujar(); renderizar();
      });
    });
    if ($('#pl-data')) $('#pl-data').addEventListener('input', function (e) {
      const v = e.target.value;
      r.data_inicio = v || null; r.data_fim = v || null;
      if (v) r.dias_semana = [H.diaSemana(v)];
      // hoje: início padrão agora + 5 min; outros dias: em branco (se o início era o automático)
      if (v === H.hojeIso()) {
        if (!r.hora_inicio || (exigeInicioFuturo(r) && r.hora_inicio < horaAgora())) r.hora_inicio = horaAuto = horaPadraoHoje();
      } else if (r.hora_inicio && r.hora_inicio === horaAuto) {
        r.hora_inicio = horaAuto = null;
      }
      const campoInicio = $('#pl-inicio');
      campoInicio.value = r.hora_inicio || '';
      if (exigeInicioFuturo(r)) campoInicio.min = horaAgora(); else campoInicio.removeAttribute('min');
      atualizarHorarios();
      $('#pl-data-dia').textContent = v ? H.dataExtensa(v) : '';
      if (v) previaEstado.data = v;   // a prévia acompanha a data escolhida
      sujar();
    });
    $('#cat-busca').addEventListener('input', function (e) { filtroCat.texto = e.target.value; renderCatalogo(); });
    $('#cat-grupo').addEventListener('change', function (e) { filtroCat.grupo = e.target.value; renderCatalogo(); });
    $('#cat-lista').addEventListener('click', function (e) {
      const b = e.target.closest('[data-add]');
      if (!b) return;
      const c = buscarCat(b.dataset.add);
      r.itens.push({ id: null, tipo: c.tipo, id_origem: c.id_origem, duracao_personalizada_seg: null,
        intervalo_antes_seg: 0, hora_fixa: null });
      sujar(); renderSequencia();
      toast('Adicionada: ' + c.titulo);
    });

    $('#pl-nome').addEventListener('input', function (e) {
      r.nome = e.target.value;
      r.itens.forEach(function (it) { if (it.tipo === 'livre') it.titulo = r.nome.trim(); });   // atividade própria usa o nome como título
      sujar(); renderSequencia();
    });
    function mostrarResumoDesc() {
      const t = resumoDescricao(r.descricao), el = $('#pl-desc-resumo');
      el.textContent = t || 'Sem descrição';
      el.classList.toggle('vazio', !t);
    }
    if ($('#pl-desc-editar')) {
      mostrarResumoDesc();
      $('#pl-desc-editar').addEventListener('click', function () {
        abrirVisor('Descrição: ' + (r.nome.trim() || 'data específica'), r.descricao, {
          editar: true, rotuloSalvar: 'Aplicar',
          aoSalvar: async function (v) {
            r.descricao = v; rascunhoSujo = true; mostrarResumoDesc();
            toast('Descrição alterada. Clique em Salvar na data para gravar.');
          },
        });
      });
    }
    if ($('#pl-dur-sel')) {
      $('#pl-dur-sel').value = opcaoDuracao(r.duracao_livre_seg);
      $('#pl-dur-sel').addEventListener('change', function (e) {
        const campo = $('#pl-dur-livre'), v = e.target.value;
        campo.setAttribute('aria-invalid', 'false');
        if (v === 'outra') {   // personalizar: parte do valor atual para facilitar a edição
          const atual = r.duracao_livre_seg || D.DURACAO_LIVRE_PADRAO_SEG;
          if (!campo.value.trim()) campo.value = H.duracaoEditavel(atual);
          r.duracao_livre_seg = H.lerDuracao(campo.value) > 0 ? H.lerDuracao(campo.value) : atual;
          campo.hidden = false; campo.focus(); campo.select();
        } else {
          campo.hidden = true;
          r.duracao_livre_seg = v === 'padrao' ? null : Number(v);
        }
        sujar(); atualizarHorarios();
      });
    }
    if ($('#pl-dur-livre')) $('#pl-dur-livre').addEventListener('input', function (e) {
      const txt = e.target.value.trim();
      if (!txt) { r.duracao_livre_seg = null; e.target.setAttribute('aria-invalid', 'false'); }
      else {
        const v = H.lerDuracao(txt), ok = !Number.isNaN(v) && v > 0;
        e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok) return;
        r.duracao_livre_seg = v;
      }
      sujar(); atualizarHorarios();
    });
    $('#pl-inicio').addEventListener('input', function (e) {
      r.hora_inicio = e.target.value || null; horaAuto = null; sujar(); atualizarHorarios();
    });
    $('#pl-lembrete').addEventListener('input', function (e) {
      r.lembrete_minutos = e.target.value === '' ? null : Number(e.target.value); sujar();
    });
    if ($('#pl-ativo')) $('#pl-ativo').addEventListener('change', function (e) { r.ativo = e.target.checked; sujar(); });

    function atualizarPrevia() {
      if (!$('#rec-previa')) return;   // modo Data específica não tem regra de repetição
      const datas = [];
      let d = H.hojeIso();
      for (let i = 0; i < 800 && datas.length < 4; i++, d = H.somarDias(d, 1)) if (H.valeNoDia(r, d)) datas.push(d);
      $('#rec-previa').textContent = datas.length
        ? 'Próximas datas: ' + datas.map(function (x) { return H.NOMES_DIA[H.diaSemana(x)] + ' ' + H.dataCurta(x); }).join(' · ')
        : 'Nenhuma data futura com essa regra.';
    }
    function lerRecorrencia() {
      const op = $('#pl-rec').value;
      $('#rec-semanal').hidden = op !== 'semanal';
      $('#rec-intervalo').hidden = op !== 'icustom';
      $('#rec-ajuda-intervalo').hidden = op.charAt(0) !== 'i';
      r.dias_semana = Array.from(document.querySelectorAll('.dias input:checked')).map(function (x) { return Number(x.value); });
      if (op.charAt(0) === 'i') {
        r.recorrencia = 'intervalo';
        r.intervalo_dias = op === 'icustom' ? Number($('#pl-intervalo').value) || null : Number(op.slice(1));
      } else {
        r.recorrencia = op; r.intervalo_dias = null;
      }
      sujar(); atualizarPrevia();
    }
    document.querySelectorAll('.recorrencia input, .recorrencia select').forEach(function (x) {
      x.addEventListener('change', lerRecorrencia); x.addEventListener('input', lerRecorrencia);
    });
    atualizarPrevia();

    /** Define o início de uma atividade ('' = automático). A 1ª atividade define o início da sequência. */
    function definirInicio(i, v) {
      const it = r.itens[i];
      if (i === 0) {
        r.hora_inicio = v || null; it.hora_fixa = null; horaAuto = null;
        $('#pl-inicio').value = v || '';
      } else if (!v) {
        it.hora_fixa = null;
      } else {
        // igual ao horário automático: não fixa
        const copia = r.itens.map(function (x, k) { return k === i ? Object.assign({}, x, { hora_fixa: null }) : x; });
        const auto = H.calcularSequencia(H.horaParaSeg(r.hora_inicio), copia, duracaoCatalogoDe)[i].inicio;
        it.hora_fixa = H.horaParaSeg(v) === auto ? null : v;
      }
    }

    const lista = $('#seq-lista');
    function aoEditar(e) {
      const inp = e.target, i = Number(inp.dataset.i), it = r.itens[i];
      if (!it || !inp.dataset.campo) return;
      if (inp.dataset.campo === 'inicio') {
        // 'input' só vale com horário completo; vazio só é aceito ao confirmar (change)
        if (e.type === 'input' && !inp.value) return;
        definirInicio(i, inp.value);
      } else if (inp.dataset.campo === 'dur') {
        const txt = inp.value.trim();
        if (!txt) { it.duracao_personalizada_seg = null; inp.setAttribute('aria-invalid', 'false'); }
        else {
          const v = H.lerDuracao(txt), valido = !Number.isNaN(v) && v > 0;
          inp.setAttribute('aria-invalid', valido ? 'false' : 'true');
          if (!valido) return;
          it.duracao_personalizada_seg = it.tipo !== 'livre' && v === duracaoCatalogoDe(it) ? null : v;   // igual ao catálogo: sem duração própria
        }
      } else {
        const v = H.lerDuracao(inp.value);
        inp.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
        if (Number.isNaN(v)) return;
        it.intervalo_antes_seg = v || 0;
      }
      sujar(); atualizarHorarios();
    }
    lista.addEventListener('input', aoEditar);
    lista.addEventListener('change', aoEditar);
    // ao sair de um campo, ele volta a mostrar o valor realmente em uso
    lista.addEventListener('focusout', function (e) {
      if (e.target.dataset && e.target.dataset.campo) {
        const inv = e.target.getAttribute('aria-invalid') === 'true';
        if (inv && e.target.dataset.campo === 'dur') e.target.setAttribute('aria-invalid', 'false');
        setTimeout(atualizarHorarios, 0);
      }
    });
    lista.addEventListener('click', function (e) {
      const mv = e.target.closest('[data-mover]'), rm = e.target.closest('[data-remover]');
      const lp = e.target.closest('[data-limpar]'), rs = e.target.closest('[data-restaurar]'), fc = e.target.closest('[data-focar]');
      if (fc) {
        const campo = document.querySelector('[data-campo="dur"][data-i="' + fc.dataset.focar + '"]');
        if (campo) { campo.focus(); campo.select(); }
        return;
      }
      if (rs) {
        r.itens[Number(rs.dataset.restaurar)].duracao_personalizada_seg = null;
      } else if (lp) {
        r.itens[Number(lp.dataset.limpar)].hora_fixa = null;
      } else if (mv) {
        const i = Number(mv.dataset.i), j = i + Number(mv.dataset.mover);
        const t = r.itens[i]; r.itens[i] = r.itens[j]; r.itens[j] = t;
      } else if (rm) {
        r.itens.splice(Number(rm.dataset.remover), 1);
      } else return;
      sujar(); renderSequencia();
    });

    $('#pl-descartar').addEventListener('click', function () {
      rascunho = null; rascunhoSujo = false; renderizar();
    });
    $('#pl-salvar').addEventListener('click', async function () {
      try {
        if (document.querySelector('#seq-lista [aria-invalid="true"], #pl-dur-livre[aria-invalid="true"]')) { toast('Corrija os campos destacados.', true); return; }
        if (ehData(r)) {
          if (!r.data_inicio) {
            const campo = $('#pl-data'); campo.scrollIntoView({ block: 'center' }); campo.focus();
            toast('Escolha a data.', true); return;
          }
          if (!r.itens.length && !r.nome.trim()) {
            const campo = $('#pl-nome'); campo.scrollIntoView({ block: 'center' }); campo.focus();
            toast('Informe o nome da atividade ou escolha atividades do catálogo.', true); return;
          }
          if (!r.hora_inicio || r.hora_inicio === '00:00') {
            const campo = $('#pl-inicio'); campo.scrollIntoView({ block: 'center' }); campo.focus();
            toast('Defina o horário de início da atividade (não pode ficar em branco nem 00:00).', true); return;
          }
          if (exigeInicioFuturo(r) && r.hora_inicio < horaAgora()) {
            const campo = $('#pl-inicio'); campo.min = horaAgora(); campo.scrollIntoView({ block: 'center' }); campo.focus();
            toast('Para hoje, o início deve ser a partir de agora (' + horaAgora() + ').', true); return;
          }
        }
        if (!ehData(r) && !r.hora_inicio && !(r.itens[0] && r.itens[0].hora_fixa)) {
          const campo = $('#pl-inicio'); campo.scrollIntoView({ block: 'center' }); campo.focus();
          toast('Defina o horário de início da sequência ou da 1ª atividade.', true); return;
        }
        if (ehData(r) && !r.data_inicio) {
          const campo = $('#pl-data'); campo.scrollIntoView({ block: 'center' }); campo.focus();
          toast('Escolha a data.', true); return;
        }
        if (!ehData(r) && !r.nome.trim()) {   // o campo Nome fica no alto da página: pede o nome aqui mesmo
          const f = await abrirModal('Nome do modelo',
            '<label>Como você quer chamar este modelo? <input name="nome" required maxlength="80" placeholder="Ex.: Manhã"></label>', 'Salvar modelo');
          if (!f) return;
          r.nome = f.get('nome').trim();
          $('#pl-nome').value = r.nome;
          if (!r.nome) { toast('Dê um nome ao modelo.', true); return; }
        }
        const salvo = await D.salvarModelo(r);
        rascunho = salvo; rascunhoSujo = false;
        inicioSalvo = { data: salvo.data_inicio, hora: salvo.hora_inicio }; horaAuto = null;
        toast(ehData(salvo) ? 'Programação da data salva. Ocorrências atualizadas.' : 'Modelo salvo. Ocorrências futuras atualizadas.');
        googleEmSegundoPlano(ehData(salvo) && salvo.data_inicio === H.hojeIso() ? 'hoje' : 'limpar');
        if (location.hash !== '#planejamento?modelo=' + salvo.id) location.hash = '#planejamento?modelo=' + salvo.id;
        else renderizar();
      } catch (e) {
        if (e.conflitos) { await verConflitosNaPrevia(e.conflitos); return; }
        toast(e.message, true);
      }
    });
  }

  // ---------- Modelos ----------
  async function telaModelos() {
    await D.recarregar();
    const todos = await D.listarModelos(), hoje = H.hojeIso();
    const modelos = todos.filter(function (m) { return !ehData(m); });
    const datas = todos.filter(function (m) { return ehData(m) && m.data_inicio >= hoje; })
      .sort(function (x, y) { return x.data_inicio < y.data_inicio ? -1 : x.data_inicio > y.data_inicio ? 1 : 0; });
    function cartao(m) {
      const seq = D.sequenciaModelo(m);
      const ini = seq.length ? seq[0].inicio : H.horaParaSeg(m.hora_inicio);
      const fim = seq.length ? seq[seq.length - 1].fim : ini;
      const data = ehData(m);
      return '<article class="cartao modelo' + (m.ativo ? '' : ' inativo') + '">'
        + '<div class="modelo-topo"><h2>' + esc(m.nome) + '</h2>'
        + (data ? '' : '<span class="chip ' + (m.ativo ? 'st-ok' : 'st-cancelada') + '">' + (m.ativo ? '● Ativo' : '○ Inativo') + '</span>') + '</div>'
        + '<p class="modelo-horario">' + H.segParaHora(ini) + ' – ' + H.segParaHora(fim)
        + ' <span>· ' + plural(m.itens.length, 'atividade', 'atividades') + ' · ' + H.duracaoTexto(fim - ini) + '</span></p>'
        + '<p class="ajuda">' + esc(data ? fmtData(m.data_inicio) : H.textoRecorrencia(m))
        + (m.lembrete_minutos != null ? ' · lembrete ' + m.lembrete_minutos + ' min antes' : '') + '</p>'
        + '<ol class="modelo-itens">' + m.itens.map(function (it, i) {
          const c = D.itemCatalogo(it);
          return '<li><span>' + H.segParaHora(seq[i].inicio) + '</span> ' + esc(c ? c.titulo : '—') + '</li>';
        }).join('') + '</ol>'
        + '<div class="botoes"><a class="btn" href="#planejamento?modelo=' + m.id + '">Editar</a>'
        + (data ? '<button type="button" class="btn" data-excluir="' + m.id + '">Excluir</button>'
          : '<button type="button" class="btn" data-duplicar="' + m.id + '">Duplicar</button>'
          + '<button type="button" class="btn" data-ativar="' + m.id + '" data-valor="' + (!m.ativo) + '">'
          + (m.ativo ? 'Desativar' : 'Ativar') + '</button>') + '</div></article>';
    }
    return '<div class="cabecalho-tela"><h1 class="titulo-pagina">Modelos</h1>'
      + '<div class="nav-data"><a class="btn" href="#planejamento">+ Data específica</a>'
      + '<a class="btn primario" href="#planejamento?modelo=novo&tipo=modelo">+ Novo modelo</a></div></div>'
      + '<p class="ajuda">Programações reutilizáveis. Cada modelo gera as ocorrências dos próximos dias automaticamente, sem duplicar.</p>'
      + (modelos.length ? '<div class="lista-modelos">' + modelos.map(cartao).join('') + '</div>' : '<p class="vazio">Nenhum modelo ainda.</p>')
      + (datas.length ? '<h2 class="subtitulo">Datas específicas</h2>'
        + '<p class="ajuda">Programações de um único dia, a partir de hoje.</p><div class="lista-modelos">' + datas.map(cartao).join('') + '</div>' : '');
  }

  function aposModelos() {
    conteudo.querySelectorAll('.lista-modelos').forEach(function (lista) { lista.addEventListener('click', async function (e) {
      const dup = e.target.closest('[data-duplicar]'), at = e.target.closest('[data-ativar]'), ex = e.target.closest('[data-excluir]');
      try {
        if (ex) {
          if (!confirm('Excluir esta programação? As atividades futuras ainda não iniciadas serão removidas; o histórico permanece.')) return;
          await D.excluirModelo(ex.dataset.excluir);
          toast('Programação excluída.');
          googleEmSegundoPlano('limpar');
          renderizar();
        } else if (dup) {
          const m = (await D.listarModelos()).find(function (x) { return x.id === dup.dataset.duplicar; });
          m.id = null; m.nome += ' (cópia)'; m.ativo = false;
          m.itens.forEach(function (it) { it.id = null; });
          await D.salvarModelo(m);
          toast('Cópia criada (inativa).');
          renderizar();
        } else if (at) {
          const ativo = at.dataset.valor === 'true';
          await D.definirAtivo(at.dataset.ativar, ativo);
          googleEmSegundoPlano('limpar');
          toast(ativo ? 'Modelo ativado. Ocorrências futuras geradas.' : 'Modelo desativado. Ocorrências futuras não iniciadas removidas.');
          renderizar();
        }
      } catch (err) {
        if (err.conflitos) {
          const ir = await modalConflitos(err.conflitos, 'Conflito de horários: o modelo não foi ativado',
            'Ativar este modelo geraria atividades sobrepostas a outras. Ajuste o modelo ou desative o outro.', 'Abrir no planejamento');
          if (ir && at) location.hash = '#planejamento?modelo=' + at.dataset.ativar;
          return;
        }
        toast(err.message, true);
      }
    }); });
  }

  // ---------- Histórico ----------
  let filtroHist = null;

  async function telaHistorico() {
    const hoje = H.hojeIso();
    if (!filtroHist) filtroHist = { de: H.somarDias(hoje, -29), ate: hoje, status: '', categoria: '', texto: '' };
    const f = filtroHist;
    const ate = f.ate > hoje ? hoje : f.ate;
    const todas = await D.listarOcorrencias(f.de, ate);
    const categorias = Array.from(new Set(catalogo.map(function (c) { return c.categoria; }).concat(['Personalizada'])));
    const txt = f.texto.trim().toLowerCase();
    const lista = todas.filter(function (o) {
      return (!f.status || statusVisual(o) === f.status || o.status === f.status)
        && (!f.categoria || o.categoria_planejada === f.categoria)
        && (!txt || o.titulo_planejado.toLowerCase().indexOf(txt) !== -1);
    }).reverse();
    const ind = I.calcular(lista);
    const LIMITE = 400;

    return '<h1 class="titulo-pagina">Histórico</h1>'
      + '<form class="filtros barra-filtros" id="hist-filtros">'
      + '<label>De <input type="date" name="de" value="' + f.de + '"></label>'
      + '<label>Até <input type="date" name="ate" value="' + ate + '" max="' + hoje + '"></label>'
      + '<label>Status <select name="status"><option value="">Todos</option>'
      + Object.keys(STATUS).map(function (k) {
        return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + STATUS[k].rotulo + '</option>';
      }).join('') + '</select></label>'
      + '<label>Categoria <select name="categoria"><option value="">Todas</option>' + categorias.map(function (c) {
        return '<option' + (f.categoria === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select></label>'
      + '<label class="crescer">Atividade <input type="search" name="texto" value="' + esc(f.texto) + '" placeholder="Buscar"></label>'
      + '</form>'
      + '<p class="resumo">' + plural(lista.length, 'ocorrência', 'ocorrências') + ' · ' + ind.concluidas + ' concluídas · '
      + ind.naoRealizadas + ' não realizadas · ' + ind.canceladas + ' canceladas · ' + ind.emAberto + ' em aberto</p>'
      + (lista.length ? '<div class="tabela-rolagem"><table class="tabela"><thead><tr>'
        + '<th>Data</th><th>Planejado</th><th>Atividade</th><th>Categoria</th><th>Status</th>'
        + '<th class="num">Duração plan.</th><th class="num">Real</th><th>Concluída</th><th>Motivo / observação</th></tr></thead><tbody>'
        + lista.slice(0, LIMITE).map(function (o) {
          const nota = [o.status === 'nao_realizada'
            ? (nomeMotivo(o.motivo_id) || (o.marcada_automaticamente ? 'Automática (fim do dia)' : '')) : '', o.observacao]
            .filter(Boolean).join(' — ');
          return '<tr><td>' + H.dataCurta(o.data) + ' <small>' + H.NOMES_DIA[H.diaSemana(o.data)] + '</small></td>'
            + '<td class="num">' + H.horaDe(o.inicio_planejado) + '–' + H.horaDe(o.fim_planejado) + '</td>'
            + '<td>' + esc(o.titulo_planejado) + '</td><td>' + esc(o.categoria_planejada) + '</td>'
            + '<td>' + chip(o) + '</td>'
            + '<td class="num">' + H.duracaoTexto(o.duracao_planejada_seg) + '</td>'
            + '<td class="num">' + (o.duracao_real_seg != null ? H.duracaoTexto(o.duracao_real_seg) : '—') + '</td>'
            + '<td class="num">' + (o.concluido_em ? H.horaDe(o.concluido_em) : '—') + '</td>'
            + '<td>' + esc(nota) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + (lista.length > LIMITE ? '<p class="ajuda">Mostrando as ' + LIMITE + ' mais recentes. Refine o período.</p>' : '')
        : '<p class="vazio">Nenhuma ocorrência com esses filtros.</p>');
  }

  function aposHistorico() {
    const form = $('#hist-filtros');
    let t;
    form.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        const fd = new FormData(form);
        filtroHist = { de: fd.get('de') || filtroHist.de, ate: fd.get('ate') || filtroHist.ate,
          status: fd.get('status'), categoria: fd.get('categoria'), texto: fd.get('texto') };
        const foco = document.activeElement && document.activeElement.name;
        renderizar().then(function () {
          const el = foco && $('#hist-filtros [name="' + foco + '"]');
          if (el) { el.focus(); if (el.type === 'search') el.setSelectionRange(el.value.length, el.value.length); }
        });
      }, 250);
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  // ---------- Análises ----------
  let filtroAn = { dias: 30, grupo: 'categoria' };
  let dadosEvolucao = [];

  const AGRUPAMENTOS = {
    categoria: ['Categoria', function (o) { return o.categoria_planejada || 'Sem categoria'; }],
    area: ['Área', function (o) { return o.area_planejada || (o.tipo === 'rotina' ? 'Rotinas' : o.tipo === 'livre' ? 'Atividades próprias' : 'Sem área'); }],
    tipo: ['Tipo', function (o) { return o.tipo === 'rotina' ? 'Rotina' : o.tipo === 'livre' ? 'Atividade própria' : 'Exercício'; }],
    atividade: ['Atividade', function (o) { return o.titulo_planejado; }],
  };

  function inicioSemana(iso) { return H.somarDias(iso, 1 - H.diaSemana(iso)); }

  async function telaAnalises() {
    const hoje = H.hojeIso();
    const de = H.somarDias(hoje, -(filtroAn.dias - 1));
    const ocs = await D.listarOcorrencias(de, hoje);
    const ind = I.calcular(ocs, D.TOLERANCIA_PONTUALIDADE_MIN);
    const tol = D.TOLERANCIA_PONTUALIDADE_MIN;

    // Evolução: por dia até 31 dias; por semana acima disso
    const semanal = filtroAn.dias > 31;
    const buckets = {};
    ocs.forEach(function (o) {
      const k = semanal ? inicioSemana(o.data) : o.data;
      (buckets[k] = buckets[k] || []).push(o);
    });
    dadosEvolucao = [];
    for (let d = semanal ? inicioSemana(de) : de; d <= hoje; d = H.somarDias(d, semanal ? 7 : 1)) {
      const r = I.calcular(buckets[d] || []);
      dadosEvolucao.push({ chave: d, rotulo: semanal ? 'Sem. ' + H.dataCurta(d) : H.dataCurta(d),
        taxa: r.taxa, concluidas: r.concluidas, base: r.base, semanal: semanal });
    }

    const grupos = I.agrupar(ocs, AGRUPAMENTOS[filtroAn.grupo][1], tol);
    const maxMotivo = Math.max.apply(null, Object.values(ind.motivos).concat([1]));
    const motivosLista = Object.keys(ind.motivos).map(function (k) {
      return { nome: k === 'sem' ? 'Sem motivo (marcada ao fim do dia)' : nomeMotivo(Number(k)), n: ind.motivos[k] };
    }).sort(function (a, b) { return b.n - a.n; });

    const varDur = ind.variacaoDuracao;
    return '<div class="cabecalho-tela"><h1 class="titulo-pagina">Análises</h1>'
      + '<div class="segmentado" role="group" aria-label="Período">' + [7, 30, 90].map(function (n) {
        return '<button type="button" data-dias="' + n + '" aria-pressed="' + (filtroAn.dias === n) + '">' + n + ' dias</button>';
      }).join('') + '</div></div>'
      + (ind.base === 0 ? '<p class="vazio">Sem registros concluídos ou não realizados no período.</p>' : '')
      + '<div class="kpis kpis-4">'
      + kpi('Taxa de conclusão', pct(ind.taxa), ind.concluidas + ' de ' + ind.base + ' · canceladas não contam')
      + kpi('Não realizadas', ind.naoRealizadas, ind.naoRealizadasAuto + ' marcadas automaticamente')
      + kpi('Pontualidade', pct(ind.pontualidade), 'até ' + tol + ' min após o previsto · base ' + ind.comInicio + ' com início registrado')
      + kpi('Tempo real × planejado', varDur == null ? '—' : (varDur >= 0 ? '+' : '−') + Math.abs(Math.round(varDur * 100)) + '%',
        ind.comDuracaoReal ? H.duracaoTexto(ind.somaReal) + ' real × ' + H.duracaoTexto(ind.somaPlanejada) + ' plan. · base ' + ind.comDuracaoReal : 'sem duração real registrada')
      + '</div>'
      + '<section class="cartao"><h2>Taxa de conclusão por ' + (semanal ? 'semana' : 'dia') + '</h2>'
      + '<div class="grafico" id="graf-evolucao"></div><div class="tooltip" id="graf-tooltip" hidden></div>'
      + '<details><summary>Ver como tabela</summary><table class="tabela compacta"><thead><tr><th>' + (semanal ? 'Semana' : 'Dia')
      + '</th><th class="num">Concluídas</th><th class="num">Base</th><th class="num">Taxa</th></tr></thead><tbody>'
      + dadosEvolucao.map(function (d) {
        return '<tr><td>' + d.rotulo + '</td><td class="num">' + d.concluidas + '</td><td class="num">' + d.base
          + '</td><td class="num">' + pct(d.taxa) + '</td></tr>';
      }).join('') + '</tbody></table></details></section>'
      + '<section class="cartao"><div class="cartao-topo"><h2>Desempenho por ' + AGRUPAMENTOS[filtroAn.grupo][0].toLowerCase() + '</h2>'
      + '<select id="an-grupo" aria-label="Agrupar por">' + Object.keys(AGRUPAMENTOS).map(function (k) {
        return '<option value="' + k + '"' + (filtroAn.grupo === k ? ' selected' : '') + '>Por ' + AGRUPAMENTOS[k][0].toLowerCase() + '</option>';
      }).join('') + '</select></div>'
      + '<div class="tabela-rolagem"><table class="tabela"><thead><tr><th>' + AGRUPAMENTOS[filtroAn.grupo][0] + '</th>'
      + '<th>Taxa de conclusão</th><th class="num">Concl.</th><th class="num">Não real.</th><th class="num">Canc.</th>'
      + '<th class="num">Pontualidade</th><th class="num">Real × plan.</th></tr></thead><tbody>'
      + grupos.map(function (g) {
        const v = g.ind.variacaoDuracao;
        return '<tr><td>' + esc(g.chave) + '</td>'
          + '<td><div class="barra-tabela"><span class="trilho"><span style="width:' + ((g.ind.taxa || 0) * 100) + '%"></span></span>'
          + '<span class="num">' + pct(g.ind.taxa) + '</span></div></td>'
          + '<td class="num">' + g.ind.concluidas + '</td><td class="num">' + g.ind.naoRealizadas + '</td>'
          + '<td class="num">' + g.ind.canceladas + '</td><td class="num">' + pct(g.ind.pontualidade) + '</td>'
          + '<td class="num">' + (v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>'
      + '<section class="cartao"><h2>Principais motivos de não execução</h2>'
      + (motivosLista.length ? '<ul class="barras-h">' + motivosLista.map(function (m) {
        return '<li><span class="barras-rotulo">' + esc(m.nome) + '</span><span class="trilho"><span style="width:'
          + (m.n / maxMotivo * 100) + '%"></span></span><span class="num">' + m.n + '</span></li>';
      }).join('') + '</ul>' : '<p class="vazio">Nenhuma atividade não realizada no período.</p>')
      + '</section>'
      + '<details class="cartao definicoes"><summary>Como cada indicador é calculado</summary><ul>'
      + '<li><strong>Base válida</strong>: concluídas + não realizadas. Atividades em aberto (futuras ou do dia) e canceladas ficam fora.</li>'
      + '<li><strong>Taxa de conclusão</strong>: concluídas ÷ base válida.</li>'
      + '<li><strong>Não realizada</strong>: registrada por você, ou marcada automaticamente quando o dia termina sem registro.</li>'
      + '<li><strong>Pontualidade</strong>: entre as concluídas com início registrado, % iniciadas até ' + tol + ' min após o horário planejado.</li>'
      + '<li><strong>Real × planejado</strong>: soma das durações reais ÷ soma das planejadas − 1, só nas concluídas com duração real.</li>'
      + '<li>Tudo usa o planejamento <em>gravado na ocorrência</em>; mudanças posteriores no catálogo ou nos modelos não alteram o passado.</li>'
      + '</ul></details>';
  }

  function desenharEvolucao() {
    const alvo = $('#graf-evolucao');
    if (!alvo) return;
    const dados = dadosEvolucao;
    const W = Math.max(280, alvo.clientWidth), Hh = 200;
    const m = { t: 10, r: 8, b: 26, l: 38 };
    const w = W - m.l - m.r, h = Hh - m.t - m.b;
    const passo = w / dados.length;
    const larg = Math.max(2, Math.min(18, passo - 2));   // barras finas, ao menos 2px de respiro
    const y = function (v) { return m.t + h - v * h; };
    let svg = '<svg width="' + W + '" height="' + Hh + '" role="img" aria-label="Taxa de conclusão ao longo do período">';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      svg += '<line class="grade" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>'
        + '<text class="eixo" x="' + (m.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + (v * 100) + '%</text>';
    });
    const cadaRotulo = Math.ceil(dados.length / Math.max(1, Math.floor(w / 56)));
    dados.forEach(function (d, i) {
      const x = m.l + i * passo + (passo - larg) / 2;
      if (d.taxa != null && d.taxa > 0) {
        const topo = y(d.taxa), alt = m.t + h - topo, r = Math.min(4, larg / 2, alt);
        svg += '<path class="barra-serie" d="M' + x + ',' + (m.t + h) + 'V' + (topo + r) + 'Q' + x + ',' + topo + ' ' + (x + r) + ',' + topo
          + 'H' + (x + larg - r) + 'Q' + (x + larg) + ',' + topo + ' ' + (x + larg) + ',' + (topo + r) + 'V' + (m.t + h) + 'Z"/>';
      }
      if ((dados.length - 1 - i) % cadaRotulo === 0) {
        svg += '<text class="eixo" x="' + (x + larg / 2) + '" y="' + (Hh - 8) + '" text-anchor="middle">' + d.rotulo.replace('Sem. ', '') + '</text>';
      }
      svg += '<rect class="alvo" data-i="' + i + '" x="' + (m.l + i * passo) + '" y="' + m.t + '" width="' + passo + '" height="' + h + '"/>';
    });
    svg += '<line class="base" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + (m.t + h) + '" y2="' + (m.t + h) + '"/></svg>';
    alvo.innerHTML = svg;

    const tip = $('#graf-tooltip');
    alvo.onmousemove = function (e) {
      const r = e.target.closest('.alvo');
      alvo.querySelectorAll('.alvo.ativo').forEach(function (x) { x.classList.remove('ativo'); });
      if (!r) { tip.hidden = true; return; }
      r.classList.add('ativo');
      const d = dados[Number(r.dataset.i)];
      tip.innerHTML = '<strong>' + (d.semanal ? 'Semana de ' + H.dataCurta(d.chave) : esc(H.dataExtensa(d.chave))) + '</strong><br>'
        + (d.base ? pct(d.taxa) + ' · ' + d.concluidas + ' de ' + d.base + ' concluídas' : 'Sem registros válidos');
      tip.hidden = false;
      // tooltip posicionado dentro do cartão (position: relative), acima do ponteiro
      const caixa = alvo.getBoundingClientRect();
      const px = e.clientX - caixa.left, py = e.clientY - caixa.top;
      tip.style.left = (alvo.offsetLeft + Math.min(Math.max(0, px - tip.offsetWidth / 2), caixa.width - tip.offsetWidth)) + 'px';
      tip.style.top = (alvo.offsetTop + py - tip.offsetHeight - 12) + 'px';
    };
    alvo.onmouseleave = function () {
      tip.hidden = true;
      alvo.querySelectorAll('.alvo.ativo').forEach(function (x) { x.classList.remove('ativo'); });
    };
  }

  function aposAnalises() {
    desenharEvolucao();
    conteudo.querySelectorAll('[data-dias]').forEach(function (b) {
      b.addEventListener('click', function () { filtroAn.dias = Number(b.dataset.dias); renderizar(); });
    });
    $('#an-grupo').addEventListener('change', function (e) { filtroAn.grupo = e.target.value; renderizar(); });
  }
  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (rotaAtual === 'analises') desenharEvolucao(); }, 150);
  });

  // ---------- Roteamento ----------
  const TELAS = {
    painel: [telaPainel, aposPainel],
    execucao: [telaExecucao, aposExecucao],
    planejamento: [telaPlanejamento, aposPlanejamento],
    modelos: [telaModelos, aposModelos],
    historico: [telaHistorico, aposHistorico],
    analises: [telaAnalises, aposAnalises],
  };

  function lerRota() {
    const h = location.hash.replace(/^#/, '');
    const partes = h.split('?');
    const params = {};
    new URLSearchParams(partes[1] || '').forEach(function (v, k) { params[k] = v; });
    return { rota: TELAS[partes[0]] ? partes[0] : 'painel', params: params };
  }

  async function renderizar() {
    if (!D) return;   // ainda na tela de login
    const r = lerRota();
    const mudouTela = r.rota !== rotaAtual;
    rotaAtual = r.rota; paramsAtuais = r.params;
    ocCache = {};
    document.querySelectorAll('.abas a').forEach(function (a) {
      if (a.dataset.rota === r.rota) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    try {
      const t = TELAS[r.rota];
      conteudo.innerHTML = await t[0](r.params);
      if (t[1]) t[1](r.params);
      if (mudouTela) { window.scrollTo(0, 0); }
    } catch (e) {
      console.error(e);
      conteudo.innerHTML = '<p class="vazio">Erro ao carregar: ' + esc(e.message) + '</p>';
    }
  }

  let hashAnterior = location.hash;
  window.addEventListener('hashchange', function () {
    if (rotaAtual === 'planejamento' && rascunhoSujo && !location.hash.startsWith('#planejamento')) {
      if (!confirm('Há alterações não salvas no modelo. Sair mesmo assim?')) {
        history.replaceState(null, '', hashAnterior); return;
      }
      rascunho = null; rascunhoSujo = false;
    }
    hashAnterior = location.hash;
    renderizar();
  });

  // ---------- Login (Supabase Auth) ----------
  function telaLogin(erro) {
    document.body.classList.add('sem-sessao');
    conteudo.innerHTML = '<section class="cartao login"><h1 class="titulo-pagina">Entrar</h1>'
      + '<form id="form-login">'
      + '<label>E-mail <input type="email" name="email" autocomplete="username" required></label>'
      + '<label>Senha <input type="password" name="senha" autocomplete="current-password" required></label>'
      + '<p class="erro-login" id="erro-login" role="alert"' + (erro ? '' : ' hidden') + '>' + esc(erro || '') + '</p>'
      + '<button type="submit" class="btn primario">Entrar</button>'
      + '</form><p class="ajuda">Use o e-mail e a senha cadastrados no Supabase Auth deste projeto.</p></section>';
    const form = $('#form-login');
    form.email.focus();
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Entrando…';
      try {
        const s = await A.conexao.entrar(form.email.value.trim(), form.senha.value);
        await abrirSessao(s);
      } catch (err) {
        const p = $('#erro-login');
        p.textContent = err.message; p.hidden = false;
        btn.disabled = false; btn.textContent = 'Entrar';
      }
    });
  }

  async function abrirSessao(sessao) {
    conteudo.innerHTML = '<p class="vazio">Carregando catálogo do Supabase…</p>';
    const cat = await A.conexao.carregarCatalogo();
    D = A.dados = A.criarRemoto(A.conexao.cliente(), cat);
    document.body.classList.remove('sem-sessao');
    $('#usuario-email').textContent = sessao.user.email;
    $('#usuario').hidden = false;
    $('#aviso').hidden = true;
    A.conexao.googleStatus().then(function (s) { googleAtivo = !!s.conectado; }).catch(function () { /* sem integração */ });
    try {
      await carregarDados();
    } catch (e) {   // ex.: as tabelas do planejamento ainda não foram criadas no Supabase
      console.error(e);
      conteudo.innerHTML = '<section class="cartao login"><h1 class="titulo-pagina">Não foi possível carregar</h1>'
        + '<p class="erro-login">' + esc(e.message) + '</p></section>';
    }
  }

  async function carregarDados() {
    const r = await D.iniciar();
    catalogo = await D.listarCatalogo();
    motivos = await D.listarMotivos();
    await renderizar();
    if (r.vencidas) toast(plural(r.vencidas, 'atividade de dias anteriores marcada', 'atividades de dias anteriores marcadas') + ' como não realizada.');
  }

  // ---------- Início ----------
  (async function iniciar() {
    try { localStorage.removeItem('agenda-demo-v1'); } catch (e) { /* resto do protótipo com dados fictícios */ }
    if (!A.conexao.configurado()) {
      document.body.classList.add('sem-sessao');
      conteudo.innerHTML = '<section class="cartao login"><h1 class="titulo-pagina">Conexão não configurada</h1>'
        + '<p class="ajuda">Preencha a URL do projeto e a chave pública do Supabase em <code>js/config.js</code>.</p></section>';
      return;
    }
    try {
      await A.conexao.iniciar();
      A.conexao.aoSair(function () { location.hash = ''; location.reload(); });
      $('#btn-sair').addEventListener('click', function () {
        if (rascunhoSujo && !confirm('Há alterações não salvas no modelo. Sair mesmo assim?')) return;
        rascunhoSujo = false;   // já confirmado: não perguntar de novo no redirecionamento
        A.conexao.sair();
      });
      const s = await A.conexao.sessao();
      if (s) await abrirSessao(s); else telaLogin();
    } catch (e) {
      console.error(e);
      document.body.classList.add('sem-sessao');
      conteudo.innerHTML = '<section class="cartao login"><h1 class="titulo-pagina">Não foi possível conectar</h1>'
        + '<p class="erro-login">' + esc(e.message) + '</p></section>';
    }
  })();
})(window.Agenda = window.Agenda || {});
