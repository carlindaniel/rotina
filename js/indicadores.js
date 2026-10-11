/*
 * Indicadores — definições únicas (as views SQL da Etapa 8 seguirão exatamente estas regras).
 *
 * Base válida       = concluídas + não realizadas.
 *                     Agendadas/em andamento (ainda em aberto) e canceladas NÃO entram.
 * Taxa de conclusão = concluídas ÷ base válida.
 * Pontualidade      = entre as concluídas COM início registrado, % iniciadas até
 *                     TOLERANCIA minutos após o início planejado (começar antes conta como pontual).
 * Real × planejado  = Σ duração real ÷ Σ duração planejada − 1, só nas concluídas com duração real.
 */
(function (A) {
  'use strict';

  function calcular(ocs, toleranciaMin) {
    const tol = (toleranciaMin == null ? 10 : toleranciaMin) * 60000;
    const r = { total: ocs.length, concluidas: 0, naoRealizadas: 0, naoRealizadasAuto: 0, canceladas: 0,
      emAberto: 0, comInicio: 0, pontuais: 0, comDuracaoReal: 0, somaPlanejada: 0, somaReal: 0, motivos: {} };
    ocs.forEach(function (o) {
      if (o.status === 'concluida') {
        r.concluidas++;
        if (o.iniciado_em != null) {
          r.comInicio++;
          if (o.iniciado_em <= o.inicio_planejado + tol) r.pontuais++;
        }
        if (o.duracao_real_seg != null) {
          r.comDuracaoReal++;
          r.somaPlanejada += o.duracao_planejada_seg;
          r.somaReal += o.duracao_real_seg;
        }
      } else if (o.status === 'nao_realizada') {
        r.naoRealizadas++;
        if (o.marcada_automaticamente) r.naoRealizadasAuto++;
        const k = o.motivo_id == null ? 'sem' : String(o.motivo_id);
        r.motivos[k] = (r.motivos[k] || 0) + 1;
      } else if (o.status === 'cancelada') {
        r.canceladas++;
      } else {
        r.emAberto++;
      }
    });
    r.base = r.concluidas + r.naoRealizadas;
    r.taxa = r.base ? r.concluidas / r.base : null;
    r.pontualidade = r.comInicio ? r.pontuais / r.comInicio : null;
    r.variacaoDuracao = r.somaPlanejada ? r.somaReal / r.somaPlanejada - 1 : null;
    return r;
  }

  /** Agrupa e calcula por chave. Retorna [{ chave, ind }] ordenado pela base válida (desc). */
  function agrupar(ocs, chaveFn, toleranciaMin) {
    const grupos = {};
    ocs.forEach(function (o) {
      const k = chaveFn(o);
      (grupos[k] = grupos[k] || []).push(o);
    });
    return Object.keys(grupos).map(function (k) {
      return { chave: k, ind: calcular(grupos[k], toleranciaMin) };
    }).sort(function (a, b) { return b.ind.base - a.ind.base || a.chave.localeCompare(b.chave); });
  }

  A.indicadores = { calcular: calcular, agrupar: agrupar };
})(window.Agenda = window.Agenda || {});
