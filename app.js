/* ===== Победи ИИ — логика ===== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------- состояние ---------- */
  const S = {
    card: null,
    mode: null, // 'memory' | 'text'
    phase: 'idle',
    answers: [], // {raw, graded: bool}
    qIndex: 0,
    readDeadline: 0,
    readTimerId: null,
    distractTimerId: null,
    quizDeadline: 0,
    quizTimerId: null,
    quizStart: 0,
    readSeconds: 0,
  };

  const READ_WPM = 200;        // слов в минуту — лимит чтения
  const ANSWER_SECONDS = 360;  // 6 минут на ответы
  const DISTRACT_SECONDS = 30;

  /* ---------- утилиты ---------- */
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._id);
    t._id = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function show(screen) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $('#screen-' + screen).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------- оценка ответов ---------- */
  const NUM_WORDS = {
    'один':'1','одна':'1','одну':'1','одного':'1','одному':'1','одно':'1',
    'два':'2','две':'2','двух':'2','двум':'2','двумя':'2','двадцать':'20','двадцати':'20',
    'три':'3','трех':'3','трёх':'3','трем':'3','тремя':'3','тридцать':'30','тридцати':'30',
    'четыре':'4','четырех':'4','четырёх':'4','четырем':'4','четырьмя':'4','сорок':'40','сорока':'40',
    'пять':'5','пяти':'5','пятью':'5','пятьдесят':'50','пятидесяти':'50',
    'шесть':'6','шести':'6','шестью':'6','шестьдесят':'60','шестидесяти':'60',
    'семь':'7','семи':'7','семью':'7','семьдесят':'70','семидесяти':'70',
    'восемь':'8','восьми':'8','восемью':'8','восемьдесят':'80','восьмидесяти':'80',
    'девять':'9','девяти':'9','девяносто':'90','девяноста':'90',
    'десять':'10','десяти':'10','сто':'100','ста':'100',
    'одиннадцать':'11','двенадцать':'12','тринадцать':'13','четырнадцать':'14','пятнадцать':'15',
    'шестнадцать':'16','семнадцать':'17','восемнадцать':'18','девятнадцать':'19'
  };
  const STOP = new Set(['на','в','к','из','по','и','с','у','за','о','до','от','для','это','был','была','было','не','а','но','же','бы','ли','при','об','его','их','мой','моя']);

  function normalize(s) {
    let t = (s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[«»"'`—–-]/g, ' ')
      .replace(/[.,;!?()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // время к единому виду: 09:20 -> 9:20
    t = t.replace(/\b0(\d):/g, '$1:');
    // слова-числа -> цифры, затем склейка составных числительных
    let parts = t.split(' ').map((w) => NUM_WORDS[w] || w);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+$/.test(parts[i]) && /^\d+$/.test(parts[i + 1] || '')) {
        const a = +parts[i], b = +parts[i + 1];
        if (a % 10 === 0 && b < 10 && a >= 20) { out.push(String(a + b)); i++; continue; }
      }
      out.push(parts[i]);
    }
    return out.join(' ');
  }

  function tokenMatches(tok, answerTokens) {
    if (/^\d/.test(tok)) {
      return answerTokens.some((a) => a === tok || a.replace(':', '') === tok.replace(':', ''));
    }
    if (tok.length < 2) return true; // мелкие предлоги не проверяем
    const stem = tok.slice(0, Math.min(4, tok.length));
    return answerTokens.some((a) => a.slice(0, Math.min(4, a.length)) === stem);
  }

  function gradeFactual(raw, q) {
    const n = normalize(raw);
    if (!n) return false;
    const at = n.split(' ');
    return q.accept.some((variant) => {
      const vt = normalize(variant).split(' ').filter((w) => w && !STOP.has(w));
      return vt.length > 0 && vt.every((tok) => tokenMatches(tok, at));
    });
  }

  function isRefusal(raw) {
    const n = normalize(raw);
    if (!n) return false;
    return /нет ответ|не указан|не сказан|нет данных|неизвестн|не говорит|отсутств|нет в тексте|не привод|не назван|не сообщ/.test(n);
  }
  function gradeCard(card, answers) {
    const res = { factual: 0, refusals: 0, unfounded: 0, perQ: [] };
    card.questions.forEach((q, i) => {
      const raw = answers[i];
      let ok = false, kind = '';
      if (q.type === 'U') {
        if (isRefusal(raw)) { ok = true; kind = 'refusal'; res.refusals++; }
        else if ((raw || '').trim() === '') { kind = 'empty'; }
        else { kind = 'unfounded'; res.unfounded++; }
      } else {
        ok = gradeFactual(raw, q);
        if (ok) { kind = 'ok'; res.factual++; }
        else kind = (raw || '').trim() === '' ? 'empty' : 'wrong';
      }
      res.perQ.push({ raw, ok, kind });
    });
    res.A = Math.round((res.factual / 8) * 1000) / 10;
    return res;
  }


  /* ---------- выбор карточки ---------- */
  function pickCard(length) {
    const pool = window.CARDS.filter((c) => c.lengthPlan === length && c.id !== 'U300-P');
    const arr = pool.length ? pool : window.CARDS.filter((c) => c.id !== 'U300-P');
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ---------- навигация ---------- */
  function nav(target) {
    stopTimers();
    if (target === 'home') show('home');
    if (target === 'how') { show('home'); setTimeout(() => $('#how').scrollIntoView({ behavior: 'smooth' }), 60); }
    if (target === 'setup') { resetSetup(); show('setup'); }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (b) nav(b.dataset.nav);
  });

  /* ---------- настройка ---------- */
  let selLength = null, selMode = null;
  $$('#length-grid .length-opt').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#length-grid .length-opt').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      selLength = +b.dataset.length;
      updateStartBtn();
    });
  });
  $$('#mode-grid .mode-opt').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#mode-grid .mode-opt').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      selMode = b.dataset.mode;
      updateStartBtn();
    });
  });
  function updateStartBtn() {
    $('#btn-start').disabled = !(selLength && selMode);
  }
  function resetSetup() {
    selLength = selMode = null;
    $$('#length-grid .length-opt, #mode-grid .mode-opt').forEach((x) => x.classList.remove('sel'));
    $('#btn-start').disabled = true;
  }

  $('#btn-start').addEventListener('click', () => {
    S.card = pickCard(selLength);
    S.mode = selMode;
    startReading();
  });

  /* ---------- чтение ---------- */
  function startReading() {
    const c = S.card;
    const words = c.text.split(/\s+/).filter(Boolean).length;
    S.readSeconds = Math.max(30, Math.round((words / READ_WPM) * 60));
    $('#read-title').textContent = c.title;
    $('#read-meta').textContent = `${c.kind} · ${words} слов · целевой блок фактов ≈ ${c.posPlan}% длины`;
    $('#read-text').innerHTML = c.text
      .split('\n\n')
      .map((p) => '<p>' + p.replace(/&/g, '&').replace(/</g, '<') + '</p>')
      .join('');
    show('read');
    S.phase = 'read';
    S.readDeadline = Date.now() + S.readSeconds * 1000;
    tickRead();
    S.readTimerId = setInterval(tickRead, 250);
    // правила говорят: разминка — открытая карточка
  }

  function tickRead() {
    const left = (S.readDeadline - Date.now()) / 1000;
    $('#read-time').textContent = fmtTime(left);
    $('#readbar-fill').style.width = (100 - (left / S.readSeconds) * 100).toFixed(1) + '%';
    const t = $('#read-timer');
    if (left <= 10) t.classList.add('warn'); else t.classList.remove('warn');
    if (left <= 0) { finishReading(); }
  }

  function finishReading() {
    if (S.phase !== 'read') return;
    stopTimers();
    S.phase = 'distract';
    startDistract();
  }
  $('#btn-read-done').addEventListener('click', finishReading);

  /* ---------- отвлечение ---------- */
  const SYMS = '★◆●▲✦◐';
  function randomSeq(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += SYMS[Math.floor(Math.random() * SYMS.length)];
    return out;
  }

  function startDistract() {
    S.seq = randomSeq(6);
    $('#distract-symbols').textContent = S.seq;
    const inp = $('#distract-input');
    inp.value = '';
    show('distract');
    setTimeout(() => inp.focus(), 350);
    const end = Date.now() + DISTRACT_SECONDS * 1000;
    S.distractTimerId = setInterval(() => {
      const left = Math.ceil((end - Date.now()) / 1000);
      $('#distract-time').textContent = left;
      if (left <= 0) finishDistract();
    }, 250);
  }

  function finishDistract() {
    if (S.phase !== 'distract') return;
    stopTimers();
    S.phase = 'quiz';
    S.answers = new Array(10).fill('');
    S.qIndex = 0;
    const side = $('#textside');
    side.hidden = (S.mode !== 'text');
    $('#textside-body').innerHTML = S.card.text
      .split('\n\n')
      .map((p) => '<p>' + p.replace(/&/g, '&').replace(/</g, '<') + '</p>')
      .join('');
    side.classList.remove('open');
    $('#textside-toggle span:first-child').textContent = 'Показать текст';
    show('quiz');
    startQuizTimer();
    renderQuestion();
  }

  /* ---------- вопросы ---------- */
  function startQuizTimer() {
    S.quizStart = Date.now();
    S.quizDeadline = Date.now() + ANSWER_SECONDS * 1000;
    S.quizTimerId = setInterval(() => {
      const left = (S.quizDeadline - Date.now()) / 1000;
      $('#quiz-time').textContent = fmtTime(left);
      const t = $('#quiz-timer');
      if (left <= 30) t.classList.add('warn'); else t.classList.remove('warn');
      if (left <= 0) finishQuiz();
    }, 250);
  }

  function renderQuestion() {
    const c = S.card, i = S.qIndex;
    if (i >= 10) { finishQuiz(); return; }
    $('#quiz-progress').textContent = `Вопрос ${i + 1} из 10`;
    $('#quiz-bar-fill').style.width = (i / 10) * 100 + '%';
    $('#q-num').textContent = 'вопрос ' + (i + 1);
    $('#q-text').textContent = c.questions[i].q;
    const inp = $('#q-input');
    inp.value = S.answers[i] || '';
    inp.focus();
  }

  function saveCurrent() {
    S.answers[S.qIndex] = $('#q-input').value;
  }

  $('#q-input').addEventListener('input', saveCurrent);
  $('#q-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#q-next').click(); });

  $('#q-noanswer').addEventListener('click', () => {
    $('#q-input').value = 'В тексте нет ответа';
    saveCurrent();
    $('#q-next').click();
  });

  $('#q-next').addEventListener('click', () => {
    saveCurrent();
    const cur = (S.answers[S.qIndex] || '').trim();
    if (!cur) { toast('Введите ответ или нажмите «В тексте нет ответа»'); return; }
    S.qIndex++;
    if (S.qIndex >= 10) finishQuiz();
    else renderQuestion();
  });

  $('#textside-toggle').addEventListener('click', () => {
    const side = $('#textside');
    side.classList.toggle('open');
    $('#textside-toggle span:first-child').textContent = side.classList.contains('open') ? 'Скрыть текст' : 'Показать текст';
  });

  /* ---------- результаты ---------- */
  function finishQuiz() {
    if (S.phase !== 'quiz') return;
    stopTimers();
    S.phase = 'results';
    saveCurrent();
    const card = S.card;
    const mine = gradeCard(card, S.answers);
    const models = gradeCard(card, card.model.answers);

    $('#score-you').textContent = mine.A + '%';
    $('#score-ai').textContent = models.A + '%';
    $('#u-correct').textContent = mine.factual + ' / 8';
    $('#u-refusals').textContent = mine.refusals + ' / 2';

    const vw = $('#v-word');
    vw.classList.remove('win', 'lose', 'draw');
    if (mine.A > models.A) { vw.textContent = 'Вы победили'; vw.classList.add('win'); $('#v-sub').textContent = 'Ваш результат по вопросам с ответом в тексте выше архивного результата модели.'; }
    else if (mine.A < models.A) { vw.textContent = 'Модель впереди'; vw.classList.add('lose'); $('#v-sub').textContent = 'Архивный результат модели выше. Посмотрите разбор: часто решает не «память вообще», а доступ к тексту и точность деталей.'; }
    else { vw.textContent = 'Ничья'; vw.classList.add('draw'); $('#v-sub').textContent = 'Одинаково по основному показателю — сравните поведение на вопросах без ответа в тексте.'; }

    $('#honest-banner').textContent = S.mode === 'memory'
      ? 'Вы отвечали без текста. Модель отвечала с доступом к тексту. Это сравнение памяти с инструментом, у которого источник под рукой.'
      : 'Оба отвечали с доступом к тексту. Но модель не устаёт и не отвлекается, а вы — можете: это тоже условие.';

    $('#modelcard').innerHTML =
      `Архивный ответ модели: <b>${card.model.name}</b>, дата фиксации — ${card.model.date}, ` +
      `${card.model.access}, запусков — ${card.model.runs}. Ответы сохранены заранее и не пересчитываются на ходу; ` +
      `тот же текст, те же вопросы, что были у вас.`;

    const bd = $('#breakdown');
    bd.innerHTML = '';
    card.questions.forEach((q, i) => {
      const r = mine.perQ[i];
      const mok = models.perQ[i].ok;
      const div = document.createElement('div');
      div.className = 'bq';
      const yourAns = (S.answers[i] || '').trim() || '— пусто —';
      div.innerHTML =
        `<div class="bq-head"><span class="bq-n">№${i + 1}</span><span class="bq-q"></span>` +
        `<span class="mark ${r.ok ? 'ok' : 'no'}">${r.ok ? 'верно' : (q.type === 'U' ? (r.kind === 'unfounded' ? 'догадка' : 'пропуск') : 'ошибка')}</span></div>` +
        `<div class="row"><span class="k">Ваш ответ</span><span></span></div>` +
        `<div class="row"><span class="k">Модель</span><span></span></div>` +
        `<div class="row"><span class="k">Эталон</span><span></span></div>` +
        `<div class="src"></div>`;
      div.querySelector('.bq-q').textContent = q.q;
      div.querySelectorAll('.row span:last-child')[0].textContent = yourAns;
      div.querySelectorAll('.row span:last-child')[1].textContent = card.model.answers[i] + (mok ? '' : ' (неточно)');
      div.querySelectorAll('.row span:last-child')[2].textContent = q.key;
      div.querySelector('.src').textContent = 'Основание: ' + q.source;
      bd.appendChild(div);
    });

    show('results');
  }

  /* ---------- таймеры ---------- */
  function stopTimers() {
    clearInterval(S.readTimerId);
    clearInterval(S.distractTimerId);
    clearInterval(S.quizTimerId);
  }

  /* ---------- повтор ---------- */
  $('#btn-again').addEventListener('click', () => {
    if (!selLength || !selMode) { nav('setup'); return; }
    S.card = pickCard(selLength);
    S.mode = selMode;
    startReading();
  });

})();
