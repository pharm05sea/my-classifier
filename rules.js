/* 규칙 기반 분류. 칸·긴급도 이름과 판정 순서는 criteria.json, 판단 낱말은 keywords.json 에서 받는다.
   이 파일에는 분류 칸 이름, 긴급도 이름, 낱말이 하나도 적혀 있지 않다.

   판정 방법
   칸     : 칸마다 문장에 들어 있는 판단 낱말의 개수를 센다. 가장 많은 칸을 고른다.
            동점이면 criteria.json 의 판정 순서에서 앞선 칸. 맞는 낱말이 하나도 없으면 판정 순서의 마지막 칸.
   긴급도 : 긴급도마다 판단 낱말 개수를 센다. 가장 많은 쪽을 고른다.
            동점이면 criteria.json 에서 앞에 적힌(더 급한) 쪽. 낱말이 하나도 없으면 criteria.json 의 두 번째 단계(기본값).
   '핵심 행동'을 읽는 규칙은 만들지 않았다. 낱말 개수와 판정 순서만 쓴다. */
(function (root) {
  function found(text, entry) {
    var out = [];
    ((entry && entry["낱말"]) || []).forEach(function (w) {
      if (text.indexOf(w["낱말"]) >= 0) out.push(w["낱말"]);
    });
    return out;
  }
  function quote(words) {
    return words.slice(0, 3).map(function (w) { return "‘" + w + "’"; }).join(", ");
  }
  function ro(word) {
    var code = word.charCodeAt(word.length - 1) - 0xAC00;
    if (code >= 0 && code < 11172) {
      var jong = code % 28;
      return (jong === 0 || jong === 8) ? "로" : "으로";
    }
    return "로";
  }

  function classify(text, criteria, keywords) {
    var order = criteria["판정순서"];
    var cats = criteria["칸"].map(function (c) { return c["이름"]; });
    var catHits = {}, catScore = {}, best = 0;
    cats.forEach(function (c) {
      catHits[c] = found(text, keywords["칸"][c]);
      catScore[c] = catHits[c].length;
      if (catScore[c] > best) best = catScore[c];
    });
    var category, catWhy;
    if (best === 0) {
      category = order[order.length - 1];
      catWhy = "맞는 낱말이 없어 판정 순서의 마지막 칸인 " + category + ro(category) + " 분류";
    } else {
      var tied = order.filter(function (c) { return catScore[c] === best; });
      category = tied[0];
      catWhy = quote(catHits[category]) + " 낱말이 있어 " + category + ro(category) + " 분류" +
        (tied.length > 1 ? "(동점 " + tied.join("·") + " 중 판정 순서가 앞선 칸)" : "");
    }

    var urgs = criteria["긴급도"].map(function (u) { return u["이름"]; });
    var urgHits = {}, urgScore = {}, ubest = 0;
    urgs.forEach(function (u) {
      urgHits[u] = found(text, keywords["긴급도"][u]);
      urgScore[u] = urgHits[u].length;
      if (urgScore[u] > ubest) ubest = urgScore[u];
    });
    var urgency, urgWhy;
    if (ubest === 0) {
      urgency = urgs[1];
      urgWhy = "긴급도 낱말이 없어 기본값 " + urgency;
    } else {
      urgency = urgs.filter(function (u) { return urgScore[u] === ubest; })[0];
      urgWhy = "긴급도는 " + quote(urgHits[urgency]) + " 낱말이 있어 " + urgency;
    }
    return { category: category, urgency: urgency, reason: catWhy + " / " + urgWhy, catWords: catHits[category], urgWords: urgHits[urgency] };
  }

  root.NpdRules = { classify: classify };
})(typeof window !== "undefined" ? window : this);
