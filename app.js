/* 화면 동작. 칸·긴급도 이름은 criteria.json, 판단 낱말은 keywords.json,
   정답은 data/answer.json(채점 버튼을 누를 때만)에서 읽는다.
   AI 분류는 /api/classify(Vercel 서버 함수)에 개인정보를 가린 문장만 보내 받는다. API 키는 이 파일에 없다.
   입력 문장, 분류 결과, 채점 내역은 서버·브라우저 어디에도 저장하지 않는다(내려받기 버튼을 누를 때만 파일을 만든다). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var S = { criteria: null, keywords: null, ready: false, gold: null, ruleRows: null, aiRuns: [], busy: false,
            items: [], seq: 0, status: null, currentId: null, edit: null, dash: { cat: "", urg: "", stat: "", open: false } };   // items: 대시보드용, 이 화면을 연 동안만 메모리에 보관
  var BATCH = 10;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    for (var i = 3; i < arguments.length; i++) if (arguments[i]) e.append(arguments[i]);
    return e;
  }
  function pct(n, d) { return (n / d * 100).toFixed(1) + "%"; }
  function getJson(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function names(list) { return list.map(function (x) { return x["이름"]; }); }

  /* ---------- 탭 ---------- */
  var TABS = ["classify", "dashboard", "grade"];
  function showTab() {
    var t = (location.hash || "").replace("#", "");
    if (TABS.indexOf(t) < 0) t = "classify";
    TABS.forEach(function (k) {
      $("view-" + k).hidden = k !== t;
      $("tab-" + k).setAttribute("aria-selected", k === t ? "true" : "false");
    });
  }
  window.addEventListener("hashchange", showTab);

  /* ---------- AI 서버 호출 ---------- */
  // 성공: {ok:true, results:[...], model}  실패: {ok:false, error:"이유"}
  function callAI(texts) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 75000);
    return fetch("/api/classify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: texts }), signal: ctl.signal
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* JSON이 아님 */ }
        if (!r.ok || !j) return { ok: false, error: (j && j.error) || ("AI 서버 응답 오류 (HTTP " + r.status + ")") };
        if (!Array.isArray(j.results) || j.results.length !== texts.length) return { ok: false, error: "AI 서버 응답 형식 오류" };
        return { ok: true, results: j.results, model: j.model };
      });
    }).catch(function (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "AI 응답 시간 초과" : "AI 서버에 연결하지 못했습니다" };
    }).then(function (v) { clearTimeout(timer); return v; });
  }
  // 유효한 판정이면 null, 아니면 이유 문자열
  function invalidReason(r) {
    if (!r) return "판정 없음";
    if (r.error) return r.error;
    if (names(S.criteria["칸"]).indexOf(r.category) < 0 || names(S.criteria["긴급도"]).indexOf(r.urgency) < 0 ||
        typeof r.reason !== "string" || !r.reason.trim()) return "유효하지 않은 판정";
    return null;
  }

  /* ---------- 1. 안건 분류 ---------- */
  function field(label, node) { return el("div", "field", null, el("div", "k", label), node); }
  function urgIndex(name) { return names(S.criteria["긴급도"]).indexOf(name); }

  function renderResult(masked, r, info) {
    var box = $("result");
    box.textContent = "";
    var catDef = (S.criteria["칸"].filter(function (c) { return c["이름"] === r.category; })[0] || {})["정의"] || "";
    var urgDef = (S.criteria["긴급도"].filter(function (u) { return u["이름"] === r.urgency; })[0] || {})["기준"] || "";
    box.append(el("div", "res-head", null,
      el("h2", null, "분류 결과"),
      el("span", "badge" + (info.mode === "ai" ? "" : " warn"), info.mode === "ai" ? "Gemini AI 분류 (" + info.model + ")" : "규칙 분류")));
    if (info.mode !== "ai") {
      box.append(el("p", "notice", "AI 없이 규칙으로 갈랐습니다"));
      box.append(el("p", "hint", "AI를 쓰지 못한 이유: " + info.error));
    }
    box.append(
      el("div", "rgrid", null,
        el("div", "rcard", null, el("div", "k", "분류 칸"), el("div", "v big", r.category), el("div", "d", catDef)),
        el("div", "rcard", null, el("div", "k", "긴급도"), el("div", "v", null, el("span", "chip lg u-" + urgIndex(r.urgency), r.urgency)), el("div", "d", urgDef))),
      el("div", "rblock", null, el("div", "k", "판정 이유"), el("p", "why", r.reason)),
      el("div", "rblock", null, el("div", "k", "개인정보를 가린 문장"), el("blockquote", "masked", masked))
    );
    box.hidden = false;
  }

  /* ---------- 분류 수정 (오른쪽 패널): 칸·긴급도·처리상태를 안건별로 고친다. 고친 값은 업무 진행 대시보드에 바로 반영된다 ---------- */
  function currentItem() { return S.items.filter(function (x) { return x.id === S.currentId; })[0] || null; }
  function showItem(it) { S.currentId = it.id; renderEditor(); }

  function renderEditor() {
    var box = $("edit-body");
    if (!box) return;
    box.textContent = "";
    S.edit = null;
    if (!S.ready) return;
    var it = currentItem();
    if (!it) {
      box.append(el("p", "hint", "문장을 분류하면 이곳에서 칸·긴급도·처리상태를 직접 고칠 수 있습니다. 고친 내용은 「업무 진행 대시보드」에 바로 반영됩니다."));
      return;
    }
    function def(list, key, v) { return (list.filter(function (x) { return x["이름"] === v; })[0] || {})[key] || ""; }
    var specs = [
      { key: "cat", label: "분류 칸", opts: names(S.criteria["칸"]), field: "category", def: function (v) { return def(S.criteria["칸"], "정의", v); } },
      { key: "urg", label: "긴급도", opts: names(S.criteria["긴급도"]), field: "urgency", def: function (v) { return def(S.criteria["긴급도"], "기준", v); } },
      { key: "stat", label: "처리상태", opts: stageNames(), field: "status", def: function (v) { return def(S.status["처리상태"], "기준", v); } }
    ];
    var refs = {};
    box.append(el("div", "k", "수정할 안건"), el("blockquote", "masked sm", it.text));
    specs.forEach(function (sp) {
      var id = "edit-" + sp.key;
      var label = el("label", "lbl", sp.label); label.setAttribute("for", id);
      var s = el("select"); s.id = id;
      sp.opts.forEach(function (o) { s.append(new Option(o, o)); });
      s.value = it[sp.field];
      var d = el("p", "edef", sp.def(s.value));
      s.addEventListener("change", function () {
        var cur = currentItem();
        if (!cur) return;
        cur[sp.field] = s.value;
        cur.edited = cur.category !== cur.origCategory || cur.urgency !== cur.origUrgency;
        d.textContent = sp.def(s.value);
        refreshState();
        renderDashboard();
      });
      refs[sp.key] = { sel: s, def: d, field: sp.field, defFn: sp.def };
      box.append(el("div", "egroup", null, label, s, d));
    });
    var state = el("div", "edit-state");
    var reset = el("button", "btn", "원래 판정으로 되돌리기"); reset.type = "button";
    reset.addEventListener("click", function () {
      var cur = currentItem();
      if (!cur) return;
      cur.category = cur.origCategory; cur.urgency = cur.origUrgency; cur.edited = false;
      syncEditor(); renderDashboard();
    });
    function refreshState() {
      var cur = currentItem();
      state.textContent = "";
      if (!cur) return;
      state.append(el("div", null, "원래 판정: " + cur.origCategory + " · 긴급도 " + cur.origUrgency + " (" + (cur.mode === "ai" ? "Gemini AI" : "규칙") + ")"));
      state.append(cur.edited ? el("div", "edited", "사람이 수정했습니다 — 대시보드에 수정한 값이 보입니다") : el("div", null, "수정하지 않았습니다"));
      reset.disabled = !cur.edited;
    }
    box.append(state, el("div", "row", null, reset));
    S.edit = { refs: refs, refreshState: refreshState };
    refreshState();
  }

  // 대시보드에서 값이 바뀌거나 안건이 지워졌을 때 오른쪽 패널을 맞춘다
  function syncEditor() {
    var it = currentItem();
    if (!it || !S.edit) { renderEditor(); return; }
    Object.keys(S.edit.refs).forEach(function (k) {
      var r = S.edit.refs[k];
      r.sel.value = it[r.field];
      r.def.textContent = r.defFn(it[r.field]);
    });
    S.edit.refreshState();
  }
  // 예시 문장: keywords.json 의 예시(data/practice.json 에서 뽑은 연습 문장)를 차례로 돌려 가며 넣는다.
  var exampleIdx = 0;
  function exampleList() {
    var seen = {}, out = [];
    ["칸", "긴급도"].forEach(function (part) {
      Object.keys(S.keywords[part]).forEach(function (key) {
        (S.keywords[part][key]["예시"] || []).forEach(function (e) {
          if (!seen[e.id]) { seen[e.id] = true; out.push(e); }
        });
      });
    });
    return out;
  }
  function onExample() {
    var status = $("status");
    if (!S.ready) { status.textContent = "기준 파일을 아직 읽지 못했습니다."; return; }
    var list = exampleList();
    if (!list.length) { status.textContent = "예시 문장이 없습니다."; return; }
    var i = exampleIdx++ % list.length;
    $("txt").value = list[i]["문장"];
    $("txt").focus();
    $("result").hidden = true;
    status.textContent = "예시 문장 " + (i + 1) + "/" + list.length + " (연습 문장 " + list[i].id + ")을 넣었습니다. 「분류하기」를 누르세요.";
  }

  function onClassify() {
    var status = $("status"), btn = $("go");
    var text = $("txt").value.trim();
    if (!S.ready) { status.textContent = "기준 파일을 아직 읽지 못했습니다."; return; }
    if (!text) { status.textContent = "문장을 먼저 입력하세요."; $("result").hidden = true; return; }
    if (S.busy) return;
    S.busy = true; btn.disabled = true; status.textContent = "AI로 분류하는 중입니다.";
    var masked = window.NpdMask.mask(text);
    callAI([masked]).then(function (res) {
      var ai = res.ok ? res.results[0] : null;
      var err = res.ok ? invalidReason(ai) : res.error;
      var shown = !err ? ai : window.NpdRules.classify(masked, S.criteria, S.keywords);
      var info = !err ? { mode: "ai", model: res.model } : { mode: "rule", error: err };
      renderResult(masked, shown, info);
      showItem(addItem(masked, shown, info));
      status.textContent = "";
    }).catch(function () {
      // 어떤 오류가 나도 분류가 멈추지 않게 규칙으로 처리한다
      var r = window.NpdRules.classify(masked, S.criteria, S.keywords);
      var info = { mode: "rule", error: "예상하지 못한 오류" };
      renderResult(masked, r, info);
      showItem(addItem(masked, r, info));
      status.textContent = "";
    }).then(function () { S.busy = false; btn.disabled = false; });
  }

  /* ---------- 2. 채점 ---------- */
  function loadGold() {
    return S.gold ? Promise.resolve(S.gold) : getJson("data/answer.json").then(function (g) { S.gold = g; return g; });
  }
  function ruleRows(gold) {
    return gold.map(function (g) {
      var r = window.NpdRules.classify(window.NpdMask.mask(g.text), S.criteria, S.keywords);
      return { fail: false, category: r.category, urgency: r.urgency, reason: r.reason };
    });
  }
  // rows[i]: {fail, category, urgency, reason, error}  (gold와 같은 순서)
  function metrics(rows, gold) {
    var worstCat = S.criteria["판정순서"][0];   // 놓치면 안전·법규 리스크로 이어지는 칸 (criteria.json)
    var m = { n: rows.length, cat: 0, urg: 0, both: 0, fail: 0, wrong: 0, worstTotal: 0, worstMiss: 0, worstFail: 0, worstCat: worstCat };
    rows.forEach(function (r, i) {
      var g = gold[i], isWorst = g["칸"] === worstCat;
      if (isWorst) m.worstTotal++;
      if (r.fail) { m.fail++; if (isWorst) m.worstFail++; return; }
      var c = r.category === g["칸"], u = r.urgency === g["긴급도"];
      if (c) m.cat++;
      if (u) m.urg++;
      if (c && u) m.both++; else m.wrong++;
      if (isWorst && !c) m.worstMiss++;
    });
    return m;
  }
  function setBusy(on) { S.busy = on; $("grade-btn").disabled = on; $("ai-grade-btn").disabled = on; }

  function onRuleGrade() {
    var status = $("grade-status");
    if (!S.ready) { status.textContent = "기준 파일을 아직 읽지 못했습니다."; return; }
    if (S.busy) return;
    setBusy(true); status.textContent = "규칙으로 채점하는 중입니다.";
    loadGold().then(function (gold) { S.ruleRows = ruleRows(gold); renderGrade(); status.textContent = ""; })
      .catch(function () { status.textContent = "data/answer.json 을 읽지 못했습니다. 서버로 열었는지(주소가 http:// 로 시작하는지) 확인하세요."; })
      .then(function () { setBusy(false); });
  }

  async function onAIGrade() {
    var status = $("grade-status");
    if (!S.ready) { status.textContent = "기준 파일을 아직 읽지 못했습니다."; return; }
    if (S.busy) return;
    setBusy(true);
    try {
      var gold = await loadGold();
      S.ruleRows = ruleRows(gold);                       // 같은 30개를 규칙으로도 채점해 나란히 비교
      var masked = gold.map(function (g) { return window.NpdMask.mask(g.text); });
      var rows = [], model = null, requests = 0;
      status.textContent = "AI 채점 중… 0/" + gold.length;
      for (var start = 0; start < gold.length; start += BATCH) {
        var end = Math.min(start + BATCH, gold.length);
        var res = await callAI(masked.slice(start, end));
        requests++;
        for (var k = start; k < end; k++) {
          var r = res.ok ? res.results[k - start] : null;
          var err = res.ok ? invalidReason(r) : res.error;
          rows.push(err ? { fail: true, error: err } : { fail: false, category: r.category, urgency: r.urgency, reason: r.reason });
        }
        if (res.ok && res.model) model = res.model;
        status.textContent = "AI 채점 중… " + end + "/" + gold.length;
      }
      S.aiRuns.push({ rows: rows, model: model, when: new Date(), requests: requests });
      renderGrade();
      status.textContent = "AI 채점 완료 " + gold.length + "/" + gold.length + " (응답 실패 " + rows.filter(function (r) { return r.fail; }).length + "건)";
    } catch (e) {
      status.textContent = S.gold ? "AI 채점 중 오류가 났습니다. 다시 눌러 주세요." : "data/answer.json 을 읽지 못했습니다. 서버로 열었는지(주소가 http:// 로 시작하는지) 확인하세요.";
    }
    setBusy(false);
  }

  function cmpTable(rm, am) {
    function row(label, a, b) {
      return el("tr", null, null, el("th", null, label), el("td", null, a), el("td", null, b));
    }
    function frac(x, n) { return x + " / " + n + " (" + pct(x, n) + ")"; }
    var t = el("table", "cmp");
    t.append(el("thead", null, null, el("tr", null, null, el("th", null, "평가 지표"), el("th", null, "규칙 기반"), el("th", null, "Gemini AI"))));
    var b = el("tbody");
    var none = "미측정";
    b.append(
      row("칸 분류 정확도", rm ? frac(rm.cat, rm.n) : none, am ? frac(am.cat, am.n) : none),
      row("긴급도 정확도", rm ? frac(rm.urg, rm.n) : none, am ? frac(am.urg, am.n) : none),
      row("둘 다 정답", rm ? rm.both + "건" : none, am ? am.both + "건" : none),
      row("오분류", rm ? rm.wrong + "건" : none, am ? am.wrong + "건" : none),
      row("응답 실패", "해당 없음", am ? am.fail + "건" : none),
      row("가장 나쁜 실수 (" + (rm || am).worstCat + " 안건을 다른 칸으로)",
        rm ? rm.worstMiss + " / " + rm.worstTotal + "건" : none,
        am ? am.worstMiss + " / " + am.worstTotal + "건" + (am.worstFail ? " (응답 실패 " + am.worstFail + "건 별도)" : "") : none)
    );
    t.append(b);
    return t;
  }

  function mark(ok) { return ok ? "○" : "✕"; }
  function predLine(label, r, g) {
    var d = el("div", "diff");
    d.append(el("b", null, label + " "));
    if (r.fail) { d.append("응답 실패 — " + r.error); return d; }
    d.append(el("span", r.category === g["칸"] ? "okt" : "bad-t", mark(r.category === g["칸"]) + " " + r.category));
    d.append(" / ");
    d.append(el("span", r.urgency === g["긴급도"] ? "okt" : "bad-t", mark(r.urgency === g["긴급도"]) + " " + r.urgency));
    return d;
  }
  function isBoth(r, g) { return !r.fail && r.category === g["칸"] && r.urgency === g["긴급도"]; }

  function mismatchList(gold, ruleR, aiR) {
    var worstCat = S.criteria["판정순서"][0], topUrg = S.criteria["긴급도"][0]["이름"];
    var ul = el("ul", "wrongs"), count = 0;
    gold.forEach(function (g, i) {
      var rr = ruleR ? ruleR[i] : null, ar = aiR ? aiR[i] : null;
      if (!((rr && !isBoth(rr, g)) || (ar && !isBoth(ar, g)))) return;
      count++;
      var li = el("li", "wrong", null, el("div", "src", g.id + " · " + g.text));
      var tags = el("div", "tags");
      if (g["칸"] === worstCat) {
        if (rr && !rr.fail && rr.category !== worstCat) tags.append(el("span", "tag bad", "가장 나쁜 실수 — 규칙"));
        if (ar && !ar.fail && ar.category !== worstCat) tags.append(el("span", "tag bad", "가장 나쁜 실수 — AI"));
        if (ar && ar.fail) tags.append(el("span", "tag bad", worstCat + " 안건인데 AI 응답 실패"));
        if (g["긴급도"] === topUrg) tags.append(el("span", "tag bad", "정답 긴급도 " + topUrg + " (안전·법규 우려 또는 임박한 차질)"));
      }
      if (g.note) tags.append(el("span", "tag", "정답에 「" + g.note + "」 표기 — 정답 그대로 적용"));
      li.append(el("div", "diff", null, el("b", null, "정답 "), g["칸"] + " / " + g["긴급도"]));
      if (rr) li.append(predLine("규칙", rr, g));
      if (ar) li.append(predLine("AI", ar, g));
      if (tags.childNodes.length) li.append(tags);
      if (rr) li.append(el("div", "rsn", "규칙의 판정 이유: " + rr.reason));
      if (ar && !ar.fail) li.append(el("div", "rsn", "AI의 판정 이유: " + ar.reason));
      ul.append(li);
    });
    return { ul: ul, count: count };
  }

  function repeatSummary(gold) {
    if (S.aiRuns.length < 2 || !S.ruleRows) return null;
    var rm = metrics(S.ruleRows, gold);
    var ms = S.aiRuns.map(function (r) { return metrics(r.rows, gold); });
    function stat(key) {
      var v = ms.map(function (m) { return m[key] / m.n * 100; });
      var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
      return { v: v, mean: mean, wobble: Math.max.apply(null, v) - Math.min.apply(null, v), gain: mean - rm[key] / rm.n * 100 };
    }
    var c = stat("cat"), u = stat("urg");
    function line(label, s) {
      return label + ": " + s.v.map(function (x) { return x.toFixed(1) + "%"; }).join(", ") + " → 규칙 대비 평균 개선 " + s.gain.toFixed(1) +
        "%p, 측정 흔들림(최대-최소) " + s.wobble.toFixed(1) + "%p → " + (s.gain > 0 && s.gain > s.wobble ? "개선 폭이 흔들림보다 큼" : "개선 폭이 흔들림보다 크지 않음");
    }
    return el("div", "notice info", null, el("b", null, "같은 조건으로 AI 채점 " + S.aiRuns.length + "회 측정"), el("div", null, line("칸", c)), el("div", null, line("긴급도", u)));
  }

  function renderGrade() {
    var out = $("grade-out");
    out.textContent = "";
    var gold = S.gold, m = S.keywords["메타"];
    var run = S.aiRuns.length ? S.aiRuns[S.aiRuns.length - 1] : null;
    var rm = S.ruleRows ? metrics(S.ruleRows, gold) : null;
    var am = run ? metrics(run.rows, gold) : null;
    var n = gold.length, noteCount = gold.filter(function (g) { return g.note; }).length;
    var list = mismatchList(gold, S.ruleRows, run && run.rows);

    out.append(el("h2", null, "채점 결과 (평가 " + n + "건)"), cmpTable(rm, am));
    out.append(el("p", "hint", "둘 다 정답 + 오분류 + 응답 실패 = 평가 건수. AI가 답하지 못한 문장은 오답으로 계산했고 응답 실패로 따로 셌습니다."));
    var rep = repeatSummary(gold);
    if (rep) out.append(rep);
    if (run) {
      var dl = $("dl-btn"); dl.hidden = false;
    }
    out.append(
      el("h3", null, "틀린 문장 " + list.count + "건 (원문 / 정답 / 규칙 판정 / AI 판정)"),
      list.count ? list.ul : el("p", "ok", "모두 맞혔습니다."),
      el("h3", null, "측정 조건"),
      el("dl", "cond", null,
        el("dt", null, "평가 건수"), el("dd", null, n + "건 (data/answer.json, 정답에 「판단이 갈린다」 표기 " + noteCount + "건 포함, 정답 그대로 적용)"),
        el("dt", null, "문장 처리"), el("dd", null, "개인정보(이름·전화번호·사번·이메일)를 가린 문장으로 규칙과 AI 모두 분류"),
        el("dt", null, "규칙"), el("dd", null, m["출처"] + " " + m["연습문장수"] + "문장에서 추출한 낱말 (최소 " + m["최소_등장_문장수"] + "문장 등장, 집중도 " + m["최소_집중도"] + " 이상). 칸은 동점이면 판정 순서(" + S.criteria["판정순서"].join(" → ") + "), 낱말이 없으면 마지막 칸. 긴급도는 동점이면 더 급한 쪽, 낱말이 없으면 " + S.criteria["긴급도"][1]["이름"]),
        el("dt", null, "AI"), el("dd", null, run ? "모델 " + (run.model || "확인 안 됨") + ", " + BATCH + "문장씩 " + run.requests + "번 요청, 온도 0, 서버 응답 대기 60초. 분류 기준은 criteria.json을 그대로 전달 (측정 " + run.when.toLocaleString("ko-KR") + ", " + S.aiRuns.length + "회차)" : "아직 측정하지 않음"),
        el("dt", null, "규칙 측정 시각"), el("dd", null, "규칙은 같은 조건에서 결과가 항상 같음"))
    );
    out.hidden = false;
  }

  /* ---------- 결과 내려받기 (누를 때만 파일을 만든다) ---------- */
  function onDownload() {
    if (!S.aiRuns.length || !S.gold) return;
    var gold = S.gold, run = S.aiRuns[S.aiRuns.length - 1], m = S.keywords["메타"];
    var worstCat = S.criteria["판정순서"][0];
    var rm = metrics(S.ruleRows, gold), am = metrics(run.rows, gold);
    function sum(x) {
      return { 평가건수: x.n, 칸정확도: +(x.cat / x.n * 100).toFixed(1), 칸맞힌건수: x.cat, 긴급도정확도: +(x.urg / x.n * 100).toFixed(1), 긴급도맞힌건수: x.urg,
        둘다정답: x.both, 오분류: x.wrong, 응답실패: x.fail, 가장나쁜실수: x.worstMiss, 가장나쁜실수_대상: x.worstTotal };
    }
    var obj = {
      측정조건: {
        정답파일: "data/answer.json", 평가건수: gold.length, 판단이갈린다_표기: gold.filter(function (g) { return g.note; }).length,
        문장처리: "이름·전화번호·사번·이메일을 가린 문장으로 분류",
        규칙: { 낱말출처: m["출처"], 연습문장수: m["연습문장수"], 최소_등장_문장수: m["최소_등장_문장수"], 최소_집중도: m["최소_집중도"], 낱말_최소_길이: m["낱말_최소_길이"] },
        AI: { 모델: run.model, 문장씩: BATCH, 요청횟수: run.requests, 온도: 0, 서버응답대기초: 60, 측정시각: run.when.toISOString() },
        가장나쁜실수_정의: worstCat + " 정답 안건을 다른 칸으로 분류"
      },
      정확도: { 규칙: sum(rm), AI: sum(am) },
      응답실패건수: am.fail,
      측정회차: S.aiRuns.map(function (r, i) {
        var x = metrics(r.rows, gold);
        return { 회차: i + 1, 모델: r.model, 측정시각: r.when.toISOString(), 칸정확도: +(x.cat / x.n * 100).toFixed(1), 긴급도정확도: +(x.urg / x.n * 100).toFixed(1), 둘다정답: x.both, 오분류: x.wrong, 응답실패: x.fail };
      }),
      문장별: gold.map(function (g, i) {
        var rr = S.ruleRows[i], ar = run.rows[i];
        return {
          id: g.id, 문장: g.text, 정답: { 칸: g["칸"], 긴급도: g["긴급도"], note: g.note || null },
          규칙: { 칸: rr.category, 긴급도: rr.urgency, 이유: rr.reason, 칸정답: rr.category === g["칸"], 긴급도정답: rr.urgency === g["긴급도"] },
          AI: ar.fail ? { 응답실패: true, 오류이유: ar.error }
            : { 응답실패: false, 칸: ar.category, 긴급도: ar.urgency, 이유: ar.reason, 칸정답: ar.category === g["칸"], 긴급도정답: ar.urgency === g["긴급도"] },
          가장나쁜실수_규칙: g["칸"] === worstCat && rr.category !== worstCat,
          가장나쁜실수_AI: g["칸"] === worstCat && !ar.fail && ar.category !== worstCat
        };
      })
    };
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "ai_채점결과.json";
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 3. 업무 진행 대시보드 (이 화면을 연 동안만 메모리에 보관, 어디에도 저장하지 않음) ---------- */
  function stageNames() { return names(S.status["처리상태"]); }
  function doneStage() { var s = stageNames(); return s[s.length - 1]; }   // 마지막 단계가 완료

  function addItem(masked, r, info) {
    var rec = { text: masked, category: r.category, urgency: r.urgency, reason: r.reason, mode: info.mode, model: info.model || null, at: Date.now(),
                origCategory: r.category, origUrgency: r.urgency, edited: false };
    var same = S.items.filter(function (x) { return x.text === masked; })[0];
    var item = same;
    if (same) Object.assign(same, rec);                  // 같은 문장을 다시 분류하면 새 판정으로 덮어쓰고, 처리상태는 그대로 둔다
    else { rec.id = ++S.seq; rec.status = stageNames()[0]; S.items.push(rec); item = rec; }
    renderDashboard();
    return item;
  }

  function buildDashboard() {
    var v = $("view-dashboard");
    v.textContent = "";
    function filterSelect(id, label, opts, key) {
      var s = el("select"); s.id = id; s.setAttribute("aria-label", label);
      s.append(new Option(label + " 전체", ""));
      opts.forEach(function (o) { s.append(new Option(o, o)); });
      s.addEventListener("change", function () { S.dash[key] = s.value; renderDashboard(); });
      return s;
    }
    var fill = el("button", "btn", "예시 문장으로 채워 보기"); fill.type = "button"; fill.id = "dash-fill";
    fill.addEventListener("click", onFillExamples);
    var clear = el("button", "btn", "모두 지우기"); clear.type = "button"; clear.id = "dash-clear";
    var armed = false;
    clear.addEventListener("click", function () {
      if (!S.items.length) return;
      if (!armed) {
        armed = true; clear.textContent = "정말 지우기";
        setTimeout(function () { armed = false; clear.textContent = "모두 지우기"; }, 3000);
      } else { armed = false; clear.textContent = "모두 지우기"; S.items = []; renderDashboard(); syncEditor(); }
    });
    var openOnly = el("input"); openOnly.type = "checkbox"; openOnly.id = "dash-open";
    openOnly.addEventListener("change", function () { S.dash.open = openOnly.checked; renderDashboard(); });
    var openLabel = el("label", "chk", null, openOnly, " 미해결만 (" + doneStage() + " 제외)"); openLabel.setAttribute("for", "dash-open");
    var tiles = el("div", "tiles"); tiles.id = "dash-tiles";
    var progress = el("div", "progress"); progress.id = "dash-progress";
    var matrix = el("div", "tbl-scroll"); matrix.id = "dash-matrix";
    var count = el("p", "hint"); count.id = "dash-count";
    var list = el("ul", "wrongs"); list.id = "dash-list";
    var msg = el("p", "hint"); msg.id = "dash-msg";
    v.append(
      el("h2", null, "업무 진행 대시보드"),
      el("p", "hint", "「NPD 안건 분류」에서 분류한 안건이 업무로 쌓입니다. 안건마다 처리상태(" + stageNames().join(" → ") + ")를 목록에서 직접 바꿔 가며 진행 상황을 봅니다. 처리상태는 분류기가 정하지 않고 사람이 정합니다."),
      el("p", "hint", "이 화면을 연 동안만 보관하고, 새로고침하거나 닫으면 사라집니다(입력 문장을 저장하지 않는 원칙). 개인정보를 가린 문장만 담습니다."),
      el("div", "row", null, fill, clear), msg,
      tiles, progress,
      el("h3", null, "칸별 진행 현황"), matrix,
      el("h3", null, "업무 목록"),
      el("div", "filters", null,
        filterSelect("dash-cat", "칸", names(S.criteria["칸"]), "cat"),
        filterSelect("dash-urg", "긴급도", names(S.criteria["긴급도"]), "urg"),
        filterSelect("dash-stat", "처리상태", stageNames(), "stat"),
        openLabel),
      count, list
    );
  }

  function tile(n, label, alert, small) {
    return el("div", "tile" + (alert && n ? " alert" : ""), null, el("div", "n" + (small ? " sm" : ""), String(n)), el("div", "l", label));
  }

  function renderDashboard() {
    var tab = $("tab-dashboard");
    tab.textContent = "업무 진행 대시보드" + (S.items.length ? " (" + S.items.length + ")" : "");
    if (!S.ready || !$("dash-tiles")) return;
    var cats = names(S.criteria["칸"]), urgs = names(S.criteria["긴급도"]), stages = stageNames();
    var done = doneStage(), worstCat = S.criteria["판정순서"][0], topUrg = urgs[0];
    var items = S.items, n = items.length;
    function byStage(s) { return items.filter(function (x) { return x.status === s; }).length; }
    var doneN = byStage(done);
    var urgentOpen = items.filter(function (x) { return x.urgency === topUrg && x.status !== done; }).length;

    // 요약 타일: 전체, 단계별 건수, 긴급 미해결
    var tiles = $("dash-tiles"); tiles.textContent = "";
    tiles.append(tile(n, "전체 업무"));
    stages.forEach(function (s) { tiles.append(tile(byStage(s), s)); });
    tiles.append(tile(urgentOpen, "긴급 " + topUrg + " · 미해결", true));

    // 완료율 + 단계별 누적 막대
    var pr = $("dash-progress"); pr.textContent = "";
    pr.append(el("div", "rate", null, el("b", null, "완료율 " + (n ? Math.round(doneN / n * 100) : 0) + "%"), " (" + doneN + " / " + n + ")"));
    var stack = el("div", "stack");
    stages.forEach(function (s, i) {
      var c = byStage(s);
      if (!c) return;
      var seg = el("span", "seg s" + Math.min(i, 3)); seg.style.width = (c / n * 100) + "%"; seg.title = s + " " + c + "건";
      stack.append(seg);
    });
    pr.append(stack);
    var legend = el("div", "legend");
    stages.forEach(function (s, i) { legend.append(el("span", null, null, el("i", "dot s" + Math.min(i, 3)), s + " " + byStage(s))); });
    pr.append(legend);

    // 칸별 진행 현황 표: 칸 × 처리상태
    var cnt = {};
    cats.forEach(function (c) { cnt[c] = {}; stages.forEach(function (s) { cnt[c][s] = 0; }); });
    items.forEach(function (x) { if (cnt[x.category] && cnt[x.category][x.status] != null) cnt[x.category][x.status]++; });
    var table = el("table", "cmp matrix");
    var hr = el("tr", null, null, el("th", null, "칸"));
    stages.forEach(function (s) { hr.append(el("th", "num", s)); });
    hr.append(el("th", "num", "합계"), el("th", "num", "미해결"));
    table.append(el("thead", null, null, hr));
    var body = el("tbody"), colTotals = stages.map(function () { return 0; });
    cats.forEach(function (c) {
      var tr = el("tr", null, null, el("th", null, c)), sum = 0;
      stages.forEach(function (s, i) {
        var k = cnt[c][s]; sum += k; colTotals[i] += k;
        var td = el("td", "num", k ? String(k) : "·");
        if (k) td.style.background = "color-mix(in srgb, var(" + (s === done ? "--ok" : "--accent") + ") " + Math.round(14 + 40 * k / Math.max(1, n)) + "%, transparent)";
        tr.append(td);
      });
      var open = sum - cnt[c][done];
      tr.append(el("td", "num tot", String(sum)), el("td", "num tot" + (open && c === worstCat ? " bad-t" : ""), String(open)));
      body.append(tr);
    });
    var total = el("tr", "foot", null, el("th", null, "합계"));
    colTotals.forEach(function (k) { total.append(el("td", "num tot", String(k))); });
    total.append(el("td", "num tot", String(n)), el("td", "num tot", String(n - doneN)));
    body.append(total);
    table.append(body);
    var m = $("dash-matrix"); m.textContent = ""; m.append(table);

    // 업무 목록: 미해결 먼저, 그다음 긴급도, 같으면 최근 순
    var f = S.dash;
    var shown = items.filter(function (x) {
      return (!f.cat || x.category === f.cat) && (!f.urg || x.urgency === f.urg) && (!f.stat || x.status === f.stat) && (!f.open || x.status !== done);
    });
    shown.sort(function (a, b) {
      return (a.status === done ? 1 : 0) - (b.status === done ? 1 : 0) || urgs.indexOf(a.urgency) - urgs.indexOf(b.urgency) || b.at - a.at;
    });
    $("dash-count").textContent = n ? shown.length + "건 표시 / 전체 " + n + "건 (미해결 먼저, 긴급도 순, 같으면 최근 순)" : "";
    var ul = $("dash-list"); ul.textContent = "";
    if (!shown.length) {
      ul.append(el("li", "empty", n ? "조건에 맞는 업무가 없습니다. 필터를 바꿔 보세요." : "아직 업무가 없습니다. 「NPD 안건 분류」에서 문장을 분류하거나, 위의 「예시 문장으로 채워 보기」를 눌러 보세요."));
    }
    shown.forEach(function (x) {
      var sel = el("select"); sel.setAttribute("aria-label", "처리상태");
      stages.forEach(function (s) { var o = new Option(s, s); if (s === x.status) o.selected = true; sel.append(o); });
      sel.addEventListener("change", function () { x.status = sel.value; renderDashboard(); syncEditor(); });
      var del = el("button", "btn sm", "삭제"); del.type = "button";
      del.addEventListener("click", function () { S.items = S.items.filter(function (y) { return y.id !== x.id; }); renderDashboard(); syncEditor(); });
      var tags = el("div", "tags");
      tags.append(
        el("span", "chip u-" + urgs.indexOf(x.urgency), "긴급도 " + x.urgency),
        el("span", "tag" + (x.category === worstCat ? " bad" : ""), x.category),
        el("span", "tag", x.mode === "ai" ? "Gemini AI 분류" : "규칙 분류"),
        el("span", "tag", new Date(x.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))
      );
      if (x.edited) tags.append(el("span", "tag", "사람이 수정 (원래 " + x.origCategory + " · " + x.origUrgency + ")"));
      ul.append(el("li", "wrong item" + (x.urgency === topUrg && x.status !== done ? " hi" : "") + (x.status === done ? " done" : ""), null,
        el("div", "src", x.text), tags, el("div", "rsn", "판정 이유: " + x.reason),
        el("div", "row", null, el("span", "hint", "처리상태"), sel, del)));
    });
  }

  // 예시 문장(keywords.json의 연습 문장 예시)을 한꺼번에 분류해 대시보드를 채운다
  async function onFillExamples() {
    var msg = $("dash-msg"), btn = $("dash-fill");
    if (!S.ready || S.busy) return;
    var examples = exampleList();
    if (!examples.length) { msg.textContent = "예시 문장이 없습니다."; return; }
    S.busy = true; btn.disabled = true;
    try {
      var texts = examples.map(function (e) { return window.NpdMask.mask(e["문장"]); });
      for (var start = 0; start < texts.length; start += BATCH) {
        var chunk = texts.slice(start, start + BATCH);
        msg.textContent = "예시 문장을 분류하는 중… " + start + "/" + texts.length;
        var res = await callAI(chunk);
        chunk.forEach(function (t, k) {
          var r = res.ok ? res.results[k] : null;
          var err = res.ok ? invalidReason(r) : res.error;
          if (!err) addItem(t, r, { mode: "ai", model: res.model });
          else addItem(t, window.NpdRules.classify(t, S.criteria, S.keywords), { mode: "rule", error: err });
        });
      }
      msg.textContent = "예시 문장 " + texts.length + "개를 분류했습니다. 처리상태는 신규로 시작하니 목록에서 바꿔 보세요.";
    } catch (e) {
      msg.textContent = "예시 문장을 채우다 오류가 났습니다. 다시 눌러 주세요.";
    }
    S.busy = false; btn.disabled = false;
  }

  /* ---------- 시작 ---------- */
  function boot() {
    showTab();
    $("ex").addEventListener("click", onExample);
    $("go").addEventListener("click", onClassify);
    $("grade-btn").addEventListener("click", onRuleGrade);
    $("ai-grade-btn").addEventListener("click", onAIGrade);
    $("dl-btn").addEventListener("click", onDownload);
    Promise.all([getJson("criteria.json"), getJson("keywords.json"), getJson("status.json")]).then(function (v) {
      S.criteria = v[0]; S.keywords = v[1]; S.status = v[2]; S.ready = true;
      $("load-note").hidden = true;
      buildDashboard(); renderDashboard(); renderEditor();
    }).catch(function () {
      var n = $("load-note");
      n.textContent = "criteria.json, keywords.json, status.json 중 하나를 읽지 못했습니다. 파일을 그냥 열면 읽을 수 없습니다. 이 폴더에서 서버를 켜고(python -m http.server 8000) http://localhost:8000/ 로 여세요.";
      n.hidden = false;
    });
  }
  boot();
})();
