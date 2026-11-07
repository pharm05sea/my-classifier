/* 화면 동작. 칸·긴급도 이름은 criteria.json, 판단 낱말은 keywords.json,
   정답은 data/answer.json(채점 버튼을 누를 때만)에서 읽는다.
   AI 분류는 /api/classify(Vercel 서버 함수)에 개인정보를 가린 문장만 보내 받는다. API 키는 이 파일에 없다.
   입력 문장, 분류 결과, 채점 내역은 서버·브라우저 어디에도 저장하지 않는다(내려받기 버튼을 누를 때만 파일을 만든다). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var S = { criteria: null, keywords: null, ready: false, gold: null, ruleRows: null, aiRuns: [], busy: false };
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
  var TABS = ["classify", "grade"];
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
    var h2 = el("h2", null, "분류 결과 ");
    h2.append(el("span", "badge" + (info.mode === "ai" ? "" : " warn"), info.mode === "ai" ? "Gemini AI 분류 (" + info.model + ")" : "규칙 분류"));
    box.append(h2);
    if (info.mode !== "ai") {
      box.append(el("p", "notice", "AI 없이 규칙으로 갈랐습니다"));
      box.append(el("p", "hint", "AI를 쓰지 못한 이유: " + info.error));
    }
    box.append(
      field("개인정보를 가린 문장", el("p", "masked", masked)),
      el("div", "pair", null,
        field("분류 칸", el("p", "big", r.category)),
        field("긴급도", el("span", "chip u-" + urgIndex(r.urgency), r.urgency))),
      field("판정 이유", el("p", "why", r.reason))
    );
    box.hidden = false;
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
      if (!err) renderResult(masked, ai, { mode: "ai", model: res.model });
      else renderResult(masked, window.NpdRules.classify(masked, S.criteria, S.keywords), { mode: "rule", error: err });
      status.textContent = "";
    }).catch(function () {
      // 어떤 오류가 나도 분류가 멈추지 않게 규칙으로 처리한다
      renderResult(masked, window.NpdRules.classify(masked, S.criteria, S.keywords), { mode: "rule", error: "예상하지 못한 오류" });
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

  /* ---------- 시작 ---------- */
  function boot() {
    showTab();
    $("go").addEventListener("click", onClassify);
    $("grade-btn").addEventListener("click", onRuleGrade);
    $("ai-grade-btn").addEventListener("click", onAIGrade);
    $("dl-btn").addEventListener("click", onDownload);
    Promise.all([getJson("criteria.json"), getJson("keywords.json")]).then(function (v) {
      S.criteria = v[0]; S.keywords = v[1]; S.ready = true;
      $("load-note").hidden = true;
    }).catch(function () {
      var n = $("load-note");
      n.textContent = "criteria.json 또는 keywords.json 을 읽지 못했습니다. 파일을 그냥 열면 읽을 수 없습니다. 이 폴더에서 서버를 켜고(python -m http.server 8000) http://localhost:8000/ 로 여세요.";
      n.hidden = false;
    });
  }
  boot();
})();
