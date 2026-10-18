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

  const NEG = new Set(['не', 'нет', 'никак', 'ни']);

  function tokMatchSingle(tok, a) {
    if (/^\d/.test(tok)) return a === tok || a.replace(':', '') === tok.replace(':', '');
    if (tok.length < 2) return true;
    return a.slice(0, Math.min(4, a.length)) === tok.slice(0, Math.min(4, tok.length));
  }

  function gradeFactual(raw, q) {
    const n = normalize(raw);
    if (!n) return false;
    // «X или Y» — несовместимые варианты не принимаются
    if (/\sили\s/.test(n)) return false;
    const at = n.split(' ');
    return q.accept.some((variant) => {
      const vt = normalize(variant).split(' ').filter((w) => w && !STOP.has(w));
      if (!vt.length) return false;
      // каждый токен должен найтись в ответе — и хотя бы одно вхождение
      // не должно стоять после отрицания («не 87» — не ответ)
      return vt.every((tok) => {
        const positions = [];
        at.forEach((a, idx) => { if (tokMatchSingle(tok, a)) positions.push(idx); });
        return positions.some((p) => !(p > 0 && NEG.has(at[p - 1])));
      });
    });
  }

  function isRefusal(raw) {
    const n = normalize(raw);
    if (!n) return false;
    const m = n.match(/нет ответ\w*|не указан\w*|не сказан\w*|нет данных|неизвестн\w*|не говорит\w*|отсутств\w*|нет в тексте|не привод\w*|не назван\w*|не сообщ\w*/);
    if (!m) return false;
    // отрезаем фразу отказа: если после неё осталась содержательная догадка
    // («нет ответа, но думаю, 20 градусов») — это не отказ, а догадка
    let rest = n.replace(m[0], ' ').replace(/\b(но|однако|просто|все|же|и)\b/g, ' ');
    const CTX = new Set(['текст','тексте','текстом','источнике','источника','материале','сведений','сведения',
      'информации','данных','ответа','ответ','указано','сказано','температура','температуры','погода','погоды',
      'вместимость','путёвка','путевка','маяк','маяку','маяка','контейнер','контейнера','стоимость','воздуха',
      'времени','время','день','дня','лет','минут','минуты','слов','документ','документе','авторы','автора',
      'глубина','глубины','врач','врача','порог','пороги','фамилия','фамилии','имя','имени']);
    const restWords = rest.split(' ').filter((w) => w && w.length > 2 && !CTX.has(w) && !STOP.has(w));
    if (restWords.length > 0 || /\d/.test(rest)) return false;
    return true;
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

  // детерминированное перемешивание вопросов: порядок фиксирован для карточки,
  // типы (F/I/U) не идут монолитными блоками подряд
  function questionOrder(card) {
    let seed = 0;
    for (const ch of card.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const idx = card.questions.map((_, i) => i);
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }

  /* ---------- навигация ---------- */
  function nav(target) {
    stopTimers();
    if (target === 'home') show('home');
    if (target === 'how') { show('home'); setTimeout(() => $('#how').scrollIntoView({ behavior: 'smooth' }), 60); }
    if (target === 'setup') { resetSetup(); show('setup'); }
    if (target === 'span') { spanReset(); show('span'); }
    if (target === 'myths') { mythsReset(); show('myths'); }
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

  $('#btn-warmup').addEventListener('click', () => {
    S.card = window.CARDS.find((c) => c.id === 'U300-P') || window.CARDS[0];
    S.mode = selMode || 'memory';
    startReading();
  });

  /* ---------- чтение ---------- */
  function startReading() {
    const c = S.card;
    const words = c.text.split(/\s+/).filter(Boolean).length;
    S.readSeconds = Math.max(30, Math.round((words / READ_WPM) * 60));
    $('#read-title').textContent = c.title;
    $('#read-meta').textContent = `${c.kind} · ${words} слов · ${S.readSeconds} секунд на чтение`;
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
  const SYMS = 'ЛМНКРТСП'; // типируемые на обычной клавиатуре
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
    S.order = questionOrder(S.card);
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
    $('#q-text').textContent = c.questions[S.order[i]].q;
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
    // ответы хранятся в порядке предъявления — пересобираем по номерам вопросов
    const ansByQ = new Array(10).fill('');
    for (let p = 0; p < 10; p++) ansByQ[S.order[p]] = S.answers[p] || '';
    const mine = gradeCard(card, ansByQ);
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
      `тот же текст, те же вопросы, что были у вас. Положение блока целевых фактов в этой карточке — ` +
      `примерно ${card.posPlan}% длины текста.`;

    const bd = $('#breakdown');
    bd.innerHTML = '';
    for (let p = 0; p < 10; p++) {
      const i = S.order[p];
      const q = card.questions[i];
      const r = mine.perQ[i];
      const mok = models.perQ[i].ok;
      const div = document.createElement('div');
      div.className = 'bq';
      const yourAns = (ansByQ[i] || '').trim() || '— пусто —';
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
    }

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

  /* ---------- тест объёма рабочей памяти ---------- */
  const SP = { level: 3, seq: '', phase: 'idle', best: 0, timer: null };

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function spanReset() {
    clearInterval(SP.timer);
    SP.phase = 'idle';
    $('#span-intro').hidden = false;
    $('#span-play').hidden = true;
    $('#span-result').hidden = true;
  }

  function spanStart() {
    SP.level = 3;
    spanRound();
  }

  function spanRound() {
    SP.phase = 'show';
    SP.seq = Array.from({ length: SP.level }, () => Math.floor(Math.random() * 10)).join('');
    $('#span-intro').hidden = true;
    $('#span-result').hidden = true;
    $('#span-play').hidden = false;
    $('#span-progress').textContent = 'Длина последовательности: ' + SP.level + ' ' + plural(SP.level, 'цифра', 'цифры', 'цифр');
    const d = $('#span-digits');
    const input = $('#span-input');
    input.value = '';
    input.hidden = true;
    $('#span-check').hidden = true;
    clearInterval(SP.timer);
    d.textContent = '';
    let i = 0;
    SP.timer = setInterval(() => {
      if (i < SP.seq.length) {
        d.textContent += SP.seq[i] + ' ';
        i++;
      } else {
        clearInterval(SP.timer);
        setTimeout(() => {
          if (SP.phase !== 'show') return;
          d.textContent = '· · ·';
          input.hidden = false;
          $('#span-check').hidden = false;
          input.focus();
          SP.phase = 'answer';
        }, 800);
      }
    }, 800);
  }

  function spanCheck() {
    if (SP.phase !== 'answer') return;
    const v = ($('#span-input').value || '').replace(/\D/g, '');
    if (v === SP.seq) {
      SP.level++;
      spanRound();
    } else {
      SP.phase = 'done';
      SP.best = Math.max(SP.best, SP.level - 1);
      $('#span-play').hidden = true;
      $('#span-result').hidden = false;
      const res = SP.level - 1;
      $('#span-span').textContent = res;
      $('#span-span-lbl').textContent = plural(res, 'цифра', 'цифры', 'цифр') + ' подряд';
      $('#span-explain').textContent =
        'Вы воспроизвели ' + res + ' ' + plural(res, 'цифру', 'цифры', 'цифр') + ' подряд. Для справки: по данным Н. Коуэна, ' +
        'при контроле повторения рабочая память удерживает около 3–5 блоков; «магическое число 7±2» Дж. Миллера ' +
        'относится к другим условиям измерения. Это упрощённая демонстрация, а не лабораторная диагностика.';
    }
  }

  $('#span-start').addEventListener('click', spanStart);
  $('#span-again').addEventListener('click', spanStart);
  $('#span-check').addEventListener('click', spanCheck);
  $('#span-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') spanCheck(); });

  /* ---------- мифы о памяти ---------- */
  const MYTHS = [
    { text: 'Человеческая память работает как видеозапись: события сохраняются в точности такими, какими были.',
      truth: false,
      explain: 'Воспоминание — реконструкция, а не копия: оно перестраивается при каждом извлечении и подвержено внушению (Э. Лофтус).' },
    { text: 'Рабочая память человека удерживает примерно 3–5 блоков информации.',
      truth: true,
      explain: 'По обзору Н. Коуэна, при контроле повторения и укрупнения центральная оценка — около четырёх блоков. «7±2» Дж. Миллера относится к другим условиям измерения.' },
    { text: 'Начало и конец списка слов запоминаются лучше, чем середина.',
      truth: true,
      explain: 'Это классический эффект серийной позиции (Б. Мёрдок, 1962). Для связного текста он проверяется отдельно — чем и занимается этот проект.' },
    { text: 'Языковая модель «помнит» ваши прошлые разговоры после закрытия сессии.',
      truth: false,
      explain: 'Модель работает только с текущим контекстом запроса. История чата передаётся заново каждым сообщением; «память» между сессиями — функция сервиса, а не самой модели.' },
    { text: 'Чем больше контекстное окно модели, тем точнее она отвечает на вопросы по длинному тексту.',
      truth: false,
      explain: 'Не обязательно: в работе Lost in the Middle качество ответов снижалось, когда важные сведения были в середине длинного контекста, а RULER показал, что не все модели отрабатывают заявленную длину.' },
    { text: 'Если человек уверенно «вспоминает» деталь, значит, она действительно была.',
      truth: false,
      explain: 'В опытах Рёдигера и Макдермотт участники уверенно вспоминали слова, которых не было. Уверенность — не доказательство точности.' },
    { text: 'Проверка себя после чтения помогает запоминанию сильнее, чем простое перечитывание.',
      truth: true,
      explain: 'В исследовании Рёдигера и Карпике предварительное извлечение материала улучшало его отсроченное воспроизведение по сравнению с повторным чтением.' },
    { text: 'Человек может по команде «стереть» конкретное воспоминание из памяти.',
      truth: false,
      explain: 'Произвольное удаление отдельного следа памяти исследованиями не подтверждается: забывание подчиняется другим закономерностям.' },
    { text: 'Модели могут ошибаться в середине длинных текстов — по форме это напоминает человеческие эффекты первичности и недавности.',
      truth: true,
      explain: 'В препринте Сальваторе и соавторов U-образная кривая у моделей напоминает серийные эффекты человека. Похожая форма ошибок не доказывает одинакового механизма.' },
    { text: 'Все люди запоминают тексты одинаково, различия — только в старании.',
      truth: false,
      explain: 'На запоминание влияют группировка материала, знакомство с темой и условия задания — поэтому в проекте используются сопоставимые тексты и фиксируются условия.' },
  ];
  let mi = 0, mscore = 0, manswered = false;

  function mythsReset() {
    mi = 0; mscore = 0;
    $('#myth-result').hidden = true;
    $('#myth-card').hidden = false;
    mythsShow();
  }

  function mythsShow() {
    manswered = false;
    const m = MYTHS[mi];
    $('#myth-progress').textContent = 'Утверждение ' + (mi + 1) + ' из ' + MYTHS.length;
    $('#myth-text').textContent = m.text;
    $('#myth-feedback').hidden = true;
    $('#myth-next').hidden = true;
    $('#myth-true').disabled = false;
    $('#myth-false').disabled = false;
  }

  function mythsAnswer(v) {
    if (manswered) return;
    manswered = true;
    const m = MYTHS[mi];
    const ok = v === m.truth;
    if (ok) mscore++;
    $('#myth-true').disabled = true;
    $('#myth-false').disabled = true;
    const fb = $('#myth-feedback');
    fb.hidden = false;
    fb.classList.remove('ok', 'no');
    fb.classList.add(ok ? 'ok' : 'no');
    $('#myth-verdict').textContent = ok ? 'Верно!' : 'Не совсем.';
    $('#myth-explain').textContent = m.explain;
    const nx = $('#myth-next');
    nx.hidden = false;
    nx.textContent = mi + 1 < MYTHS.length ? 'Дальше' : 'Итоги';
  }

  function mythsNext() {
    mi++;
    if (mi < MYTHS.length) { mythsShow(); return; }
    $('#myth-card').hidden = true;
    $('#myth-result').hidden = false;
    $('#myth-score').textContent = mscore;
  }

  $('#myth-true').addEventListener('click', () => mythsAnswer(true));
  $('#myth-false').addEventListener('click', () => mythsAnswer(false));
  $('#myth-next').addEventListener('click', mythsNext);
  $('#myth-restart').addEventListener('click', mythsReset);

})();
