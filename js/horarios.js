/*
 * Regras de horário e datas — fonte única usada pelas telas.
 * A mesma regra existe em SQL (supabase/migrations: agenda_sequencia e agenda_vale_no_dia), com resultado idêntico (testado):
 *
 *   duracao = duracao_personalizada_seg ?? duracao_segundos do catálogo
 *   inicio  = hora_fixa do item, se informada e não anterior ao fim do item anterior;
 *             senão fim_anterior + intervalo_antes_seg
 *             (1º item: hora_inicio do modelo; se o modelo não tiver, a hora_fixa do próprio 1º item)
 *   fim     = inicio + duracao
 *
 * Todos os horários são segundos desde 00:00 do dia da programação.
 */
(function (A) {
  'use strict';

  const DIA = 86400;

  function pad(n) { return String(n).padStart(2, '0'); }

  /** 'HH:MM' ou 'HH:MM:SS' -> segundos; vazio -> null */
  function horaParaSeg(txt) {
    if (!txt) return null;
    const p = String(txt).split(':').map(Number);
    if (p.some(Number.isNaN)) return null;
    return p[0] * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
  }

  /** segundos -> 'HH:MM' (com ':SS' só quando houver segundos; '+1d' se passar da meia-noite) */
  function segParaHora(seg) {
    const dias = Math.floor(seg / DIA);
    const s = ((seg % DIA) + DIA) % DIA;
    let txt = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60));
    if (s % 60) txt += ':' + pad(s % 60);
    if (dias > 0) txt += ' (+' + dias + 'd)';
    return txt;
  }

  /** segundos -> texto legível: '45 s', '12 min', '1 min 30 s', '1 h 05 min' */
  function duracaoTexto(seg) {
    if (seg == null) return '—';
    seg = Math.round(seg);
    if (seg < 60) return seg + ' s';
    if (seg >= 600) seg = Math.round(seg / 60) * 60;   // a partir de 10 min, segundos são ruído
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
    if (h) return h + ' h' + (m ? ' ' + pad(m) + ' min' : '');
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }

  /** Entrada de duração digitada: '15' (min), '1:30' (min:seg). Vazio -> null; inválido -> NaN */
  function lerDuracao(txt) {
    txt = String(txt || '').trim();
    if (!txt) return null;
    if (/^\d+$/.test(txt)) return Number(txt) * 60;
    const m = txt.match(/^(\d+):([0-5]?\d)$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }

  /** segundos -> texto editável no mesmo formato aceito por lerDuracao */
  function duracaoEditavel(seg) {
    if (seg == null) return '';
    return seg % 60 ? Math.floor(seg / 60) + ':' + pad(seg % 60) : String(seg / 60);
  }

  /**
   * Calcula a sequência de horários.
   * @param {number|null} horaInicioSeg  início do primeiro item (segundos); null = usa a hora_fixa do 1º item
   * @param {Array}  itens          { duracao_personalizada_seg, intervalo_antes_seg, hora_fixa }
   * @param {Function} duracaoCatalogo  item -> duração cadastrada (segundos)
   * @returns {Array} { inicio, fim, duracao, conflito } por item
   *   conflito = hora_fixa anterior ao fim do item anterior (o horário fixo não pôde ser respeitado)
   */
  function calcularSequencia(horaInicioSeg, itens, duracaoCatalogo) {
    let cursor = horaInicioSeg;
    return itens.map(function (it) {
      const duracao = it.duracao_personalizada_seg != null
        ? it.duracao_personalizada_seg
        : (duracaoCatalogo(it) || 0);
      const fixa = horaParaSeg(it.hora_fixa);
      let inicio, conflito = false;
      if (cursor == null) {
        inicio = fixa != null ? fixa : 0;   // sem início definido: o 1º item é quem define (0 = inválido, o chamador valida)
      } else {
        inicio = cursor + (it.intervalo_antes_seg || 0);
        if (fixa != null) {
          if (fixa < inicio) conflito = true;
          else inicio = fixa;
        }
      }
      const fim = inicio + duracao;
      cursor = fim;
      return { inicio: inicio, fim: fim, duracao: duracao, conflito: conflito };
    });
  }

  // ---- Datas locais no formato 'AAAA-MM-DD' ----

  function dataIso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function hojeIso() { return dataIso(new Date()); }
  function parseData(iso) { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function somarDias(iso, n) { const d = parseData(iso); d.setDate(d.getDate() + n); return dataIso(d); }
  /** 1 = segunda ... 7 = domingo (ISO) */
  function diaSemana(iso) { return parseData(iso).getDay() || 7; }
  /** data + segundos -> timestamp (ms) local */
  function instante(iso, seg) { return parseData(iso).getTime() + seg * 1000; }
  /** timestamp -> 'HH:MM' */
  function horaDe(ms) { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function diasEntre(a, b) { return Math.round((parseData(b) - parseData(a)) / 86400000); }

  const NOMES_DIA = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

  // ---------- Recorrência ----------
  // tipos: 'diaria' | 'semanal' (dias_semana) | 'intervalo' (a cada intervalo_dias, contando de data_inicio) | 'unica'

  /** Modelos antigos não têm `recorrencia`: deduz (data_inicio = data_fim → única; senão semanal). */
  function tipoRecorrencia(m) {
    if (m.recorrencia) return m.recorrencia;
    return m.data_fim && m.data_fim === m.data_inicio ? 'unica' : 'semanal';
  }

  /** O modelo gera ocorrência neste dia? (data = 'AAAA-MM-DD') */
  function valeNoDia(m, data) {
    if (!m.data_inicio || data < m.data_inicio || (m.data_fim && data > m.data_fim)) return false;
    switch (tipoRecorrencia(m)) {
      case 'diaria': return true;
      case 'semanal': return (m.dias_semana || []).indexOf(diaSemana(data)) !== -1;
      case 'intervalo': return m.intervalo_dias >= 1 && diasEntre(m.data_inicio, data) % m.intervalo_dias === 0;
      case 'unica': return data === m.data_inicio;
      default: return false;
    }
  }

  /** Texto curto da regra, para a lista de modelos. */
  function textoRecorrencia(m) {
    const ate = m.data_fim ? ' até ' + dataCurta(m.data_fim) : '';
    switch (tipoRecorrencia(m)) {
      case 'diaria': return 'Todos os dias · desde ' + dataCurta(m.data_inicio) + ate;
      case 'intervalo': return 'A cada ' + m.intervalo_dias + ' dias · a partir de ' + dataCurta(m.data_inicio) + ate;
      case 'unica': return 'Somente em ' + dataCurta(m.data_inicio);
      default: {
        const d = (m.dias_semana || []).slice().sort().join();
        const dias = d === '1,2,3,4,5,6,7' ? 'Todos os dias' : d === '1,2,3,4,5' ? 'Dias úteis' : d === '6,7' ? 'Fins de semana'
          : (m.dias_semana || []).slice().sort().map(function (x) { return NOMES_DIA[x]; }).join(', ');
        return dias + ' · desde ' + dataCurta(m.data_inicio) + ate;
      }
    }
  }

  function dataExtensa(iso) {
    return parseData(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function dataCurta(iso) {
    return parseData(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  A.horarios = {
    horaParaSeg, segParaHora, duracaoTexto, lerDuracao, duracaoEditavel, calcularSequencia,
    dataIso, hojeIso, parseData, somarDias, diaSemana, instante, horaDe,
    dataExtensa, dataCurta, NOMES_DIA, diasEntre, tipoRecorrencia, valeNoDia, textoRecorrencia,
  };
})(window.Agenda = window.Agenda || {});
