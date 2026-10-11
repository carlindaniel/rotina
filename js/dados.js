/*
 * Camada de dados do site: grava e lê no Supabase (tabelas agenda_*). Substitui o armazenamento local.
 *
 * A.criarRemoto(cliente, catalogo) devolve o objeto usado pelas telas. O catálogo (rotina + exercicios) é só leitura.
 * Regras de horário, repetição e conflito existem em dois lugares com o MESMO resultado (testado):
 *   • aqui (JavaScript): para a prévia ao vivo e para avisar antes de salvar;
 *   • no banco (SQL, supabase/migrations): para gerar ocorrências com o site fechado e como última barreira.
 * Por isso salvar passa por funções do banco (agenda_salvar_modelo etc.), que recusam conflitos de verdade.
 */
(function (A) {
  'use strict';

  const H = A.horarios;
  const HORIZONTE_DIAS = 14;               // ocorrências geradas à frente
  const DURACAO_LIVRE_PADRAO_SEG = 900;    // atividade própria sem duração: mantenha igual a agenda_duracao_livre_padrao() no banco
  const PAGINA = 1000;                     // o Supabase devolve no máximo 1000 linhas por consulta

  A.criarRemoto = function (cliente, catalogo) {
    const CAT = {};
    catalogo.forEach(function (c) { CAT[c.tipo + ':' + c.id_origem] = c; });

    let modelos = [];      // cache das programações (com atividades)
    let avulsas = [];      // atividades avulsas ainda ativas (entram na verificação de conflitos)
    let motivos = [];

    // ---------- utilidades ----------
    function clonar(x) { return JSON.parse(JSON.stringify(x)); }
    function hhmm(t) { return t == null ? null : (/:00$/.test(t) && t.length === 8 ? t.slice(0, 5) : t); }
    function ms(ts) { return ts == null ? null : Date.parse(ts); }
    function iso(m) { return m == null ? null : new Date(m).toISOString(); }
    function ehUuid(x) { return typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x); }

    /** Erro do Supabase -> Error com texto para a pessoa. As mensagens das regras do banco já vêm em português. */
    function erro(e) {
      const msg = (e && e.message) || String(e);
      if (/^AGENDA_CONFLITO:/.test(msg)) return new Error('Conflito de horários: ' + msg.replace(/^AGENDA_CONFLITO:\s*/, ''));
      if (/Failed to fetch|NetworkError/i.test(msg)) return new Error('Sem conexão com o Supabase.');
      if (/(relation|function) .* does not exist|Could not find the (table|function)|schema cache/i.test(msg)) {
        return new Error('As tabelas do planejamento ainda não existem no Supabase. Execute os arquivos de supabase/migrations (veja docs/CONFIGURACAO.md).');
      }
      return new Error(msg);
    }
    async function rpc(nome, args) {
      const r = await cliente.rpc(nome, args || {});
      if (r.error) throw erro(r.error);
      return r.data;
    }
    /** Lê todas as páginas (a API limita 1000 linhas por consulta). */
    async function buscarTudo(montar) {
      const out = [];
      for (let de = 0; ; de += PAGINA) {
        const r = await montar().range(de, de + PAGINA - 1);
        if (r.error) throw erro(r.error);
        out.push.apply(out, r.data);
        if (r.data.length < PAGINA) break;
      }
      return out;
    }

    // ---------- catálogo ----------
    function itemCatalogo(o) {
      if (o.tipo === 'livre') {   // atividade própria de uma data específica: título e duração vêm do próprio item
        return { tipo: 'livre', id_origem: null, titulo: o.titulo || '(sem nome)',
          duracao_segundos: o.duracao_personalizada_seg || DURACAO_LIVRE_PADRAO_SEG, url: null, id_area: null, area: null,
          categoria: 'Personalizada', ordem: null, planejavel: true };
      }
      return CAT[o.tipo + ':' + o.id_origem] || null;
    }
    function duracaoDeItem(it) { const c = itemCatalogo(it); return c ? c.duracao_segundos : 0; }
    function tituloDeItem(it) { const c = itemCatalogo(it); return c ? c.titulo : 'Atividade removida do catálogo'; }

    /**
     * Data específica sem itens do catálogo = uma atividade própria com o nome informado.
     * Devolve uma cópia com essa atividade montada (títulos próprios sincronizados com o nome); outros modelos passam direto.
     */
    function expandir(m) {
      if (H.tipoRecorrencia(m) !== 'unica') return m;
      const nome = (m.nome || '').trim();
      const c = Object.assign({}, m);
      if (!(m.itens && m.itens.length)) {
        if (!nome) return m;
        c.itens = [{ id: null, tipo: 'livre', id_origem: null, titulo: nome,
          duracao_personalizada_seg: m.duracao_livre_seg || DURACAO_LIVRE_PADRAO_SEG, intervalo_antes_seg: 0, hora_fixa: null }];
        return c;
      }
      c.itens = m.itens.map(function (it) { return it.tipo === 'livre' && nome ? Object.assign({}, it, { titulo: nome }) : it; });
      return c;
    }

    // ---------- conversões banco <-> telas ----------
    function itemDeLinha(i) {
      const it = { id: i.id, tipo: i.tipo, id_origem: i.tipo === 'rotina' ? i.id_rotina : i.tipo === 'exercicio' ? i.id_exercicio : null,
        duracao_personalizada_seg: i.duracao_personalizada_seg, intervalo_antes_seg: i.intervalo_antes_seg, hora_fixa: hhmm(i.hora_fixa) };
      if (i.tipo === 'livre') it.titulo = i.titulo;
      return it;
    }
    function modeloDeLinha(r) {
      return { id: r.id, nome: r.nome, recorrencia: r.recorrencia, dias_semana: (r.dias_semana || []).map(Number), intervalo_dias: r.intervalo_dias,
        data_inicio: r.data_inicio, data_fim: r.data_fim, hora_inicio: hhmm(r.hora_inicio), lembrete_minutos: r.lembrete_minutos, ativo: r.ativo,
        itens: (r.agenda_modelo_itens || []).slice().sort(function (a, b) { return a.posicao - b.posicao; }).map(itemDeLinha) };
    }
    function payloadModelo(m) {
      return { id: m.id || null, nome: m.nome, recorrencia: m.recorrencia, dias_semana: m.dias_semana || [], intervalo_dias: m.intervalo_dias || null,
        data_inicio: m.data_inicio, data_fim: m.data_fim || null, hora_inicio: m.hora_inicio || null, lembrete_minutos: m.lembrete_minutos,
        ativo: m.ativo !== false,
        itens: m.itens.map(function (it) {
          return { id: ehUuid(it.id) ? it.id : null, tipo: it.tipo, id_origem: it.id_origem, titulo: it.tipo === 'livre' ? it.titulo : null,
            duracao_personalizada_seg: it.duracao_personalizada_seg, intervalo_antes_seg: it.intervalo_antes_seg || 0, hora_fixa: it.hora_fixa || null };
        }) };
    }
    function ocorrenciaDeLinha(r) {
      return { id: r.id, data: r.data, modelo_id: r.modelo_id, modelo_item_id: r.modelo_item_id, tipo: r.tipo,
        id_origem: r.tipo === 'rotina' ? r.id_rotina : r.tipo === 'exercicio' ? r.id_exercicio : null,
        titulo_planejado: r.titulo_planejado, categoria_planejada: r.categoria_planejada, area_planejada: r.area_planejada,
        inicio_planejado: ms(r.inicio_planejado), duracao_planejada_seg: r.duracao_planejada_seg, fim_planejado: ms(r.fim_planejado),
        status: r.status, iniciado_em: ms(r.iniciado_em), concluido_em: ms(r.concluido_em), duracao_real_seg: r.duracao_real_seg,
        observacao: r.observacao, motivo_id: r.motivo_id, editada_manualmente: r.editada_manualmente, marcada_automaticamente: r.marcada_automaticamente,
        gcal_event_id: r.gcal_event_id };
    }

    // ---------- cache ----------
    async function recarregarModelos() {
      const r = await cliente.from('agenda_modelos').select('*, agenda_modelo_itens(*)').order('criado_em').order('id');
      if (r.error) throw erro(r.error);
      modelos = r.data.map(modeloDeLinha);
    }
    async function recarregarAvulsas() {
      const r = await cliente.from('agenda_ocorrencias').select('*').is('modelo_id', null)
        .in('status', ['agendada', 'em_andamento']).gte('data', H.somarDias(H.hojeIso(), -1));
      if (r.error) throw erro(r.error);
      avulsas = r.data.map(ocorrenciaDeLinha);
    }
    async function recarregarMotivos() {
      const r = await cliente.from('agenda_motivos').select('id, descricao').order('id');
      if (r.error) throw erro(r.error);
      motivos = r.data;
    }

    // ---------- conflitos e projeção (regras em A.projecao) ----------
    function avulsasDoDia(data) {
      const ini = H.somarDias(data, -1), fim = H.somarDias(data, 1);
      return avulsas.filter(function (o) { return o.data >= ini && o.data <= fim; }).map(function (o) {
        return { modelo_id: 'avulsa', modelo_nome: 'Avulsa', avulsa: true, titulo: o.titulo_planejado, data: o.data,
          inicio: o.inicio_planejado, fim: o.fim_planejado, duracao: o.duracao_planejada_seg };
      });
    }
    function conflitosDe(m) {
      m = expandir(m);
      const outros = modelos.filter(function (x) { return x.id !== m.id; });
      return A.projecao.conflitosDoModelo(m, outros, duracaoDeItem, tituloDeItem, avulsasDoDia, H.hojeIso());
    }
    function erroDeConflito(c) {
      const e = new Error('Há ' + c.total + ' sobreposição(ões) de horário com outras atividades. Ajuste antes de salvar.');
      e.conflitos = c;
      return e;
    }
    function sequenciaModelo(m) { return H.calcularSequencia(H.horaParaSeg(m.hora_inicio), m.itens, duracaoDeItem); }

    // ---------- API pública ----------
    return {
      modo: 'supabase',
      DURACAO_LIVRE_PADRAO_SEG: DURACAO_LIVRE_PADRAO_SEG,
      TOLERANCIA_PONTUALIDADE_MIN: 10,

      /** Marca o que venceu, gera os próximos dias e carrega os dados. */
      async iniciar() {
        const vencidas = Number(await rpc('agenda_marcar_vencidas')) || 0;
        await rpc('agenda_gerar_periodo', { p_dias: HORIZONTE_DIAS });
        await Promise.all([recarregarModelos(), recarregarAvulsas(), recarregarMotivos()]);
        return { vencidas: vencidas };
      },

      async listarCatalogo() { return clonar(catalogo); },
      async listarMotivos() { return clonar(motivos); },
      itemCatalogo: function (o) { return itemCatalogo(o); },
      expandir: expandir,
      sequenciaModelo: sequenciaModelo,

      /** Programações do cache (atualizado ao salvar/excluir). Use recarregar() ao abrir uma tela para ver mudanças de outro aparelho. */
      async listarModelos() { return clonar(modelos); },
      async recarregar() { await Promise.all([recarregarModelos(), recarregarAvulsas()]); },

      async salvarModelo(m) {
        const tipo = H.tipoRecorrencia(m);   // 'unica' = programação de uma data específica
        const nomeVazio = !m.nome || !m.nome.trim();
        if (tipo === 'unica') {
          if (nomeVazio && !m.itens.length) throw new Error('Informe o nome da atividade ou escolha atividades do catálogo.');
          if (!m.hora_inicio || m.hora_inicio === '00:00') throw new Error('Defina o horário de início da atividade (não pode ficar em branco nem 00:00).');
        } else {
          if (nomeVazio) throw new Error('Dê um nome ao modelo.');
          if (!m.itens.length) throw new Error('Adicione ao menos uma atividade.');
          if (!m.hora_inicio && !(m.itens[0] && m.itens[0].hora_fixa)) throw new Error('Defina o horário de início da sequência ou da 1ª atividade.');
        }
        if (!m.data_inicio) throw new Error(tipo === 'unica' ? 'Escolha a data.' : 'Informe a data inicial.');
        if (tipo === 'unica' && m.data_inicio < H.hojeIso()) throw new Error('Escolha uma data de hoje em diante.');
        if (tipo === 'semanal' && !(m.dias_semana || []).length) throw new Error('Escolha ao menos um dia da semana.');
        if (tipo === 'intervalo' && !(Number.isInteger(m.intervalo_dias) && m.intervalo_dias >= 1 && m.intervalo_dias <= 365)) {
          throw new Error('Informe o intervalo em dias (de 1 a 365).');
        }
        if (m.data_fim && m.data_fim < m.data_inicio) throw new Error('A data final é anterior à inicial.');
        let c = clonar(m);
        c.recorrencia = tipo;
        if (tipo === 'unica') {
          c = clonar(expandir(c)); delete c.duracao_livre_seg;
          c.ativo = true; c.data_fim = c.data_inicio;
        }
        await recarregarModelos(); await recarregarAvulsas();   // conflito é checado com os dados mais recentes
        const conflitos = conflitosDe(c);
        if (conflitos.total) throw erroDeConflito(conflitos);
        const id = await rpc('agenda_salvar_modelo', { p_modelo: payloadModelo(c) });   // o banco confere de novo e grava numa transação
        await recarregarModelos();
        return clonar(modelos.find(function (x) { return x.id === id; }));
      },

      async definirAtivo(id, ativo) {
        await recarregarModelos(); await recarregarAvulsas();
        const m = modelos.find(function (x) { return x.id === id; });
        if (ativo && m) {
          const conflitos = conflitosDe(Object.assign({}, m, { ativo: true }));
          if (conflitos.total) throw erroDeConflito(conflitos);
        }
        await rpc('agenda_definir_ativo', { p_modelo: id, p_ativo: ativo });
        await recarregarModelos();
      },

      /** Exclui uma programação: remove só o futuro ainda não iniciado; o histórico permanece. */
      async excluirModelo(id) {
        await rpc('agenda_excluir_modelo', { p_modelo: id });
        await recarregarModelos();
      },

      /** Atividades previstas em `data` com este rascunho no lugar da versão salva (ou como novo). Síncrono (usa o cache). */
      projetarDia(data, rascunho) {
        const lista = modelos.filter(function (x) { return !rascunho || x.id !== rascunho.id; });
        if (rascunho) lista.push(expandir(rascunho));
        const itens = A.projecao.itensDoDia(lista, data, duracaoDeItem, tituloDeItem).concat(avulsasDoDia(data).filter(function (x) { return x.data === data; }));
        itens.sort(function (a, b) { return a.inicio - b.inicio; });
        return A.projecao.marcarConflitos(itens);
      },
      /** Conflitos de um modelo (rascunho) com os demais, sem salvar. Síncrono (usa o cache). */
      verificarConflitos(m) { return conflitosDe(m); },

      async listarOcorrencias(de, ate) {
        const linhas = await buscarTudo(function () {
          return cliente.from('agenda_ocorrencias').select('*').gte('data', de).lte('data', ate).order('inicio_planejado').order('id');
        });
        return linhas.map(ocorrenciaDeLinha);
      },

      /** Registra execução ou ajuste. As regras de estado (ex.: futura não vira "não realizada") são aplicadas pelo banco. */
      async atualizarOcorrencia(id, patch) {
        if (patch.duracao_real_seg != null && !(patch.duracao_real_seg >= 0)) throw new Error('Duração real inválida.');
        const corpo = {};
        ['status', 'duracao_real_seg', 'observacao', 'motivo_id', 'marcada_automaticamente', 'duracao_planejada_seg'].forEach(function (k) {
          if (k in patch) corpo[k] = patch[k];
        });
        ['iniciado_em', 'concluido_em', 'inicio_planejado'].forEach(function (k) { if (k in patch) corpo[k] = iso(patch[k]); });
        if (patch.status === 'agendada') {   // desfazer: limpa o registro de execução
          Object.assign(corpo, { iniciado_em: null, concluido_em: null, duracao_real_seg: null, motivo_id: null, marcada_automaticamente: false });
        }
        const r = await cliente.from('agenda_ocorrencias').update(corpo).eq('id', id).select('*').single();
        if (r.error) throw erro(r.error);
        await recarregarAvulsas();
        return ocorrenciaDeLinha(r.data);
      },

      async criarAvulsa(p) {
        const cat = itemCatalogo(p);
        if (!cat) throw new Error('Atividade não encontrada no catálogo.');
        const duracao = p.duracao != null ? p.duracao : cat.duracao_segundos;
        const inicio = H.instante(p.data, p.inicioSeg);
        const r = await cliente.from('agenda_ocorrencias').insert({
          tipo: cat.tipo, id_rotina: cat.tipo === 'rotina' ? cat.id_origem : null, id_exercicio: cat.tipo === 'exercicio' ? cat.id_origem : null,
          titulo_planejado: cat.titulo, categoria_planejada: cat.categoria, area_planejada: cat.area, data: p.data,
          inicio_planejado: iso(inicio), duracao_planejada_seg: duracao, fim_planejado: iso(inicio + duracao * 1000),
        }).select('*').single();
        if (r.error) throw erro(r.error);
        await recarregarAvulsas();
        return ocorrenciaDeLinha(r.data);
      },
    };
  };
})(window.Agenda = window.Agenda || {});
