/*
 * Temporizador das atividades: começa ao clicar em Iniciar e toca um alarme quando a duração planejada termina.
 *
 * Para tocar com a tela desligada ou com o site em segundo plano:
 *  - o alarme é AGENDADO no relógio de áudio (Web Audio, osc.start(quando)) no momento do clique em Iniciar.
 *    O som sai na hora certa mesmo que o navegador congele o JavaScript da página;
 *  - um <audio> em laço quase silencioso mantém a sessão de mídia ativa (Android e iOS não suspendem a página
 *    enquanto ela "toca" algo) e mostra o temporizador nos controles de mídia da tela de bloqueio;
 *  - ao terminar, também vibra e mostra uma notificação do sistema (se permitida).
 * O áudio só pode começar com um toque do usuário: por isso preparar() é chamado direto no clique de Iniciar.
 * Depois de recarregar a página o temporizador continua (localStorage), mas o som só volta após um toque.
 *
 * A barra do temporizador fica fixa no rodapé em todas as telas e, quando uma janela (ex.: a Descrição) está
 * aberta, é movida para dentro dela para continuar visível e clicável. O alarme abre a própria janela por cima.
 */
(function (A) {
  'use strict';

  const CHAVE = 'agenda.temporizador';
  const ALARME_SEG = 120;          // quanto tempo o alarme toca se ninguém parar
  let estado = null;               // { id, titulo, inicio, fim, tocando }
  let ctx = null, alarmeEm = null, alarmeNos = [], audioVivo = null, tique = null, aoConcluir = null;

  const $ = function (s) { return document.querySelector(s); };
  function salvar() {
    try { if (estado) localStorage.setItem(CHAVE, JSON.stringify(estado)); else localStorage.removeItem(CHAVE); } catch (e) { /* sem armazenamento */ }
  }
  function ler() {
    try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch (e) { return null; }
  }

  // ---------- Áudio ----------
  /** WAV de 1 s quase silencioso (ruído de 1 bit): mantém a sessão de mídia ativa sem som audível. */
  function urlSilencio() {
    const taxa = 8000, n = taxa, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const txt = function (o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    txt(0, 'RIFF'); v.setUint32(4, 36 + n, true); txt(8, 'WAVE'); txt(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, taxa, true); v.setUint32(28, taxa, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    txt(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + (i % 2));
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /** Chamar dentro do clique do usuário: libera o áudio, pede permissão de notificação. */
  function preparar() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';   // iOS: continua com a tela bloqueada
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      if (ctx && ctx.state !== 'running') ctx.resume();
      if (!audioVivo) {
        audioVivo = new Audio(urlSilencio());
        audioVivo.loop = true;
        audioVivo.setAttribute('playsinline', '');
      }
      audioVivo.play().catch(function () { /* sem permissão: o alarme visual continua */ });
    } catch (e) { /* navegador sem áudio */ }
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(function () {});
  }

  function pararSom() {
    alarmeNos.forEach(function (n) { try { n.stop(); n.disconnect(); } catch (e) { /* já parado */ } });
    alarmeNos = []; alarmeEm = null;
  }

  /** Agenda no relógio de áudio o alarme (bipes em dois tons) para tocar daqui a `emSeg` segundos. */
  function agendarSom(emSeg) {
    pararSom();
    if (!ctx) return;
    const t0 = alarmeEm = ctx.currentTime + Math.max(0, emSeg);
    const ganho = ctx.createGain();
    ganho.gain.setValueAtTime(0, ctx.currentTime);
    // padrão: bip-bip-bip, pausa; repete por ALARME_SEG
    for (let t = 0; t < ALARME_SEG; t += 1.6) {
      for (let k = 0; k < 3; k++) {
        const a = t0 + t + k * 0.28;
        ganho.gain.setValueAtTime(0.0001, a);
        ganho.gain.exponentialRampToValueAtTime(0.6, a + 0.02);
        ganho.gain.setValueAtTime(0.6, a + 0.16);
        ganho.gain.exponentialRampToValueAtTime(0.0001, a + 0.2);
      }
    }
    ganho.connect(ctx.destination);
    [880, 1320].forEach(function (f) {
      const osc = ctx.createOscillator();
      osc.type = 'square'; osc.frequency.value = f;
      osc.connect(ganho);
      osc.start(t0); osc.stop(t0 + ALARME_SEG);
      alarmeNos.push(osc);
    });
    alarmeNos.push({ stop: function () {}, disconnect: function () { ganho.disconnect(); } });
  }

  function atualizarMidia(texto) {
    if (!('mediaSession' in navigator) || !estado) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: estado.titulo, artist: texto, album: 'Minha Rotina' });
    } catch (e) { /* sem suporte */ }
  }

  // ---------- Tela ----------
  function fmt(seg) {
    seg = Math.max(0, Math.ceil(seg));
    const h = Math.floor(seg / 3600), m = Math.floor(seg % 3600 / 60), s = seg % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function barra() {
    let b = $('#temporizador');
    if (!b) {
      b = document.createElement('div');
      b.id = 'temporizador'; b.className = 'temporizador'; b.setAttribute('role', 'timer'); b.hidden = true;
      b.innerHTML = '<span class="tmp-icone" aria-hidden="true">⏱</span>'
        + '<span class="tmp-texto"><strong class="tmp-tempo"></strong><span class="tmp-titulo"></span></span>'
        + '<button type="button" class="btn pequeno tmp-som" hidden>Ativar som</button>'
        + '<button type="button" class="btn pequeno tmp-parar">Parar</button>';
      b.querySelector('.tmp-parar').addEventListener('click', function () { parar(); });
      b.querySelector('.tmp-som').addEventListener('click', function () {
        preparar();
        if (estado && !estado.tocando) agendarSom((estado.fim - Date.now()) / 1000);
        b.querySelector('.tmp-som').hidden = true;
      });
      document.body.appendChild(b);
    }
    // com uma janela aberta, a barra vai para dentro dela (fora dela ficaria coberta e sem clique)
    const abertas = document.querySelectorAll('dialog[open]:not(#alarme)');
    const destino = abertas.length ? abertas[abertas.length - 1] : document.body;
    if (b.parentNode !== destino) destino.appendChild(b);
    return b;
  }

  function desenhar() {
    const b = barra();
    if (!estado) { b.hidden = true; return; }
    const resta = (estado.fim - Date.now()) / 1000;
    b.hidden = false;
    b.classList.toggle('esgotado', resta <= 0);
    b.querySelector('.tmp-tempo').textContent = resta > 0 ? fmt(resta) : 'Tempo esgotado';
    b.querySelector('.tmp-titulo').textContent = estado.titulo;
    b.querySelector('.tmp-som').hidden = !!(ctx && ctx.state === 'running') || resta <= 0;
    atualizarMidia(resta > 0 ? 'Faltam ' + fmt(resta) : 'Tempo esgotado');
  }

  function janelaAlarme() {
    let d = $('#alarme');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'alarme'; d.className = 'modal alarme';
      d.innerHTML = '<form method="dialog"><h2>⏰ Tempo esgotado</h2>'
        + '<div class="alarme-corpo"><p class="alarme-titulo"></p><p class="ajuda">A duração planejada desta atividade terminou.</p></div>'
        + '<div class="modal-acoes"><button type="submit" value="parar" class="btn">Parar alarme</button>'
        + '<button type="submit" value="concluir" class="btn primario">Concluir atividade</button></div></form>';
      d.addEventListener('close', function () {
        const id = estado && estado.id, concluir = d.returnValue === 'concluir';
        parar();
        if (concluir && id && aoConcluir) aoConcluir(id);
      });
      document.body.appendChild(d);
    }
    return d;
  }

  /** O tempo acabou: som (se ainda não estiver tocando pelo agendamento), vibração, notificação e janela. */
  function disparar() {
    if (!estado || estado.tocando) return;
    estado.tocando = true; salvar();
    if (ctx && ctx.state !== 'running') ctx.resume();
    // o som agendado já está tocando? Senão (relógio de áudio ficou parado ou página recarregada), toca agora
    if (!(ctx && alarmeEm != null && ctx.currentTime >= alarmeEm - 0.5)) agendarSom(0);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400, 200, 800]);
    if (window.Notification && Notification.permission === 'granted') {
      const opcoes = { body: estado.titulo + ': a duração planejada terminou.', tag: 'agenda-alarme', requireInteraction: true };
      const reg = navigator.serviceWorker && navigator.serviceWorker.getRegistration ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
      reg.then(function (r) { if (r) return r.showNotification('Tempo esgotado', opcoes); new Notification('Tempo esgotado', opcoes); })
        .catch(function () { try { new Notification('Tempo esgotado', opcoes); } catch (e) { /* sem notificação */ } });
    }
    const d = janelaAlarme();
    d.querySelector('.alarme-titulo').textContent = estado.titulo;
    if (!d.open) d.showModal();
    desenhar();
  }

  function laco() {
    clearInterval(tique);
    if (!estado) return;
    tique = setInterval(function () {
      if (!estado) return clearInterval(tique);
      if (Date.now() >= estado.fim) disparar();
      desenhar();
    }, 500);
    desenhar();
  }

  // ---------- API ----------
  /** Começa (ou recomeça) o temporizador de uma atividade. `duracaoSeg` conta a partir de agora. */
  function iniciar(id, titulo, duracaoSeg) {
    preparar();
    const agora = Date.now();
    estado = { id: id, titulo: titulo, inicio: agora, fim: agora + duracaoSeg * 1000, tocando: false };
    salvar();
    agendarSom(duracaoSeg);
    laco();
  }

  /** Para o temporizador (de qualquer atividade, ou só se for a de `id`). */
  function parar(id) {
    if (!estado || (id && estado.id !== id)) return;
    estado = null; salvar();
    pararSom();
    clearInterval(tique);
    if (audioVivo) audioVivo.pause();
    if (navigator.vibrate) navigator.vibrate(0);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    const d = $('#alarme');
    if (d && d.open) d.close();
    desenhar();
  }

  function atual() { return estado ? Object.assign({}, estado) : null; }

  // ao voltar para a página (tela ligada de novo), confere na hora se o tempo acabou
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && estado) {
      if (ctx && ctx.state !== 'running') ctx.resume();
      if (Date.now() >= estado.fim) disparar();
      desenhar();
    }
  });
  // janelas abrindo/fechando: leva a barra junto
  new MutationObserver(function () { if (estado) barra(); })
    .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });

  /** Retoma o temporizador salvo (após recarregar). O som precisa de um toque: a barra mostra "Ativar som". */
  function retomar() {
    const s = ler();
    if (!s || !s.fim) return;
    estado = s;
    if (estado.tocando && Date.now() - estado.fim > ALARME_SEG * 1000) { parar(); return; }   // alarme antigo, já passou
    estado.tocando = false;
    laco();
  }

  A.temporizador = {
    preparar: preparar, iniciar: iniciar, parar: parar, atual: atual, retomar: retomar,
    aoConcluir: function (fn) { aoConcluir = fn; },
  };
})(window.Agenda = window.Agenda || {});
