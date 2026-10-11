/*
 * Projeção da programação e detecção de conflitos — funções puras (sem acesso a dados nem à tela).
 *
 * "Projetar" = calcular, a partir das regras dos modelos, o que cada um geraria em um dia.
 * É a mesma conta usada pela prévia (com o rascunho ainda não salvo) e pela verificação
 * de conflitos ao salvar, para que as duas nunca discordem.
 *
 * Sobreposição: dois intervalos [início, fim) se sobrepõem quando cada um começa antes de o outro
 * terminar. Terminar exatamente quando o outro começa NÃO é conflito.
 * Os horários são instantes absolutos (ms), então atividades que passam da meia-noite
 * também conflitam com as do dia seguinte.
 */
(function (A) {
  'use strict';

  const H = A.horarios;
  const JANELA_PADRAO_DIAS = 730;   // quanto à frente procurar conflitos (2 anos cobre intervalos de até 365 dias)
  const MAX_LISTADOS = 50;

  /** O modelo tem horário de início e atividades suficientes para gerar horários? */
  function projetavel(m) {
    return !!(m && m.ativo && m.itens && m.itens.length && (m.hora_inicio || m.itens[0].hora_fixa));
  }

  /**
   * Atividades que os modelos gerariam em `data`.
   * @param {Array} modelos
   * @param {string} data  'AAAA-MM-DD'
   * @param {Function} duracaoDe  item do modelo -> duração do catálogo (s)
   * @param {Function} tituloDe   item do modelo -> título
   * @returns {Array} { modelo_id, modelo_nome, titulo, data, inicio, fim, duracao } (inicio/fim em ms)
   */
  function itensDoDia(modelos, data, duracaoDe, tituloDe) {
    const out = [];
    modelos.forEach(function (m) {
      if (!projetavel(m) || !H.valeNoDia(m, data)) return;
      const seq = H.calcularSequencia(H.horaParaSeg(m.hora_inicio), m.itens, duracaoDe);
      m.itens.forEach(function (it, i) {
        if (!(seq[i].duracao > 0)) return;   // sem duração não ocupa horário
        out.push({
          modelo_id: m.id || 'novo', modelo_nome: m.nome || '(sem nome)', titulo: tituloDe(it), data: data,
          inicio: H.instante(data, seq[i].inicio), fim: H.instante(data, seq[i].fim), duracao: seq[i].duracao,
        });
      });
    });
    return out.sort(function (a, b) { return a.inicio - b.inicio; });
  }

  function sobrepoe(a, b) { return a.inicio < b.fim && b.inicio < a.fim; }

  /** Acrescenta `conflitos` (lista dos itens com que se sobrepõe) a cada item da lista. */
  function marcarConflitos(itens) {
    itens.forEach(function (a) { a.conflitos = []; });
    for (let i = 0; i < itens.length; i++) {
      for (let j = i + 1; j < itens.length; j++) {
        if (sobrepoe(itens[i], itens[j])) { itens[i].conflitos.push(itens[j]); itens[j].conflitos.push(itens[i]); }
      }
    }
    return itens;
  }

  function resumo(x) { return { titulo: x.titulo, modelo_nome: x.modelo_nome, avulsa: !!x.avulsa, inicio: x.inicio, fim: x.fim }; }

  /**
   * Conflitos do modelo `m` com os outros modelos ativos (e atividades avulsas) nos próximos dias.
   * @param {Object} m          modelo (rascunho ou salvo)
   * @param {Array}  outros     os demais modelos (sem `m`)
   * @param {Function} extrasDoDia  data -> itens avulsos já existentes naquele dia (mesmo formato de itensDoDia)
   * @param {string} hoje       'AAAA-MM-DD'
   * @returns {{ lista: Array, total: number, truncado: boolean }}
   *   lista[i] = { data, a: item de m, b: item conflitante }
   */
  function conflitosDoModelo(m, outros, duracaoDe, tituloDe, extrasDoDia, hoje, opcoes) {
    const janela = (opcoes && opcoes.janelaDias) || JANELA_PADRAO_DIAS;
    const resultado = { lista: [], total: 0, truncado: false };
    if (!projetavel(m)) return resultado;
    let d = m.data_inicio && m.data_inicio > hoje ? m.data_inicio : hoje;
    let limite = H.somarDias(d, janela);
    if (m.data_fim && m.data_fim < limite) limite = m.data_fim;
    for (; d <= limite; d = H.somarDias(d, 1)) {
      if (!H.valeNoDia(m, d)) continue;
      const meus = itensDoDia([m], d, duracaoDe, tituloDe);
      if (!meus.length) continue;
      // vizinhos: dia anterior e seguinte entram porque atividades podem atravessar a meia-noite
      const vizinhos = itensDoDia(outros, H.somarDias(d, -1), duracaoDe, tituloDe)
        .concat(itensDoDia(outros, d, duracaoDe, tituloDe), itensDoDia(outros, H.somarDias(d, 1), duracaoDe, tituloDe),
          extrasDoDia ? extrasDoDia(d) : []);
      meus.forEach(function (a) {
        vizinhos.forEach(function (b) {
          if (!sobrepoe(a, b)) return;
          resultado.total++;
          if (resultado.lista.length < MAX_LISTADOS) resultado.lista.push({ data: d, a: resumo(a), b: resumo(b) });
          else resultado.truncado = true;
        });
      });
    }
    return resultado;
  }

  A.projecao = {
    itensDoDia: itensDoDia, marcarConflitos: marcarConflitos, conflitosDoModelo: conflitosDoModelo,
    sobrepoe: sobrepoe, projetavel: projetavel,
  };
})(window.Agenda = window.Agenda || {});
