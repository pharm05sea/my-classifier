"""keywords.json 을 만든다.

읽는 파일은 criteria.json(칸·긴급도 이름) 과 data/practice.json 두 개뿐이다.
data/answer.json 은 열지 않는다.

낱말 뽑는 방법(고정, 정답을 보고 조정하지 않는다)
  1. 연습 문장을 어절로 나누고, 어절 끝의 흔한 조사·어미를 뗀 것을 낱말로 본다(2자 이상, 숫자만인 것 제외).
  2. 어떤 칸(또는 긴급도)의 연습 문장 MIN_DF개 이상에 나오고,
     그 낱말이 들어간 연습 문장 중 MIN_PRECISION 이상이 같은 칸(긴급도)일 때만 그 칸의 판단 낱말로 남긴다.
  3. 예시 문장: 그 칸의 연습 문장 중 뽑힌 낱말이 가장 많이 들어간 2개.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_DF = 2
MIN_PRECISION = 0.7
MIN_LEN = 2
EXAMPLES = 2

SUFFIXES = sorted([
    "입니다", "했습니다", "합니다", "됩니다", "에서는", "으로는", "에서", "으로", "까지", "부터", "에게", "한테",
    "보다", "처럼", "마다", "해서", "하고", "하는", "했고", "했음", "해요", "해주세요", "주세요", "드려요", "드립니다",
    "함", "됨", "임", "은", "는", "이", "가", "을", "를", "에", "의", "로", "와", "과", "도", "만", "요", "고", "며",
], key=len, reverse=True)


VOCAB = set()  # 연습 문장에 나오는 어절 전체. main()에서 채운다.


def tokens(text):
    return [t for t in re.findall(r"[가-힣A-Za-z0-9]+", text) if not t.isdigit()]


def stems(text):
    """어절에서 조사·어미를 뗀 낱말.
    한 글자 조사(은 는 이 가 을 를 에 의 로 와 과 도 만 요 고 며 임 함 됨)는, 뗀 결과가
    연습 문장에 어절로 따로 나올 때만 뗀다. 그렇지 않으면 어절을 그대로 둔다(예: 인허가가 인허로 잘리지 않게)."""
    out = set()
    for tok in tokens(text):
        s = tok
        for suf in SUFFIXES:
            if s.endswith(suf) and len(s) - len(suf) >= MIN_LEN:
                cand = s[: -len(suf)]
                if len(suf) == 1 and cand not in VOCAB:
                    break
                s = cand
                break
        if len(s) >= MIN_LEN:
            out.add(s)
    return out


def extract(items, key, labels):
    sent_stems = [stems(x["text"]) for x in items]
    df_all = Counter()
    df_label = defaultdict(Counter)
    for x, ws in zip(items, sent_stems):
        for w in ws:
            df_all[w] += 1
            df_label[x[key]][w] += 1
    result = {}
    for lab in labels:
        picked = []
        for w, n in df_label[lab].items():
            if n >= MIN_DF and n / df_all[w] >= MIN_PRECISION:
                picked.append((n, w))
        picked.sort(key=lambda t: (-t[0], t[1]))
        words = [{"낱말": w, "등장문장수": n, "전체문장수": df_all[w]} for n, w in picked]
        wset = {w for _, w in picked}
        cand = []
        for x, ws in zip(items, sent_stems):
            if x[key] == lab:
                cand.append((-len(ws & wset), x["id"], x["text"]))
        cand.sort()
        examples = [{"id": i, "문장": t} for c, i, t in cand[:EXAMPLES] if c < 0]
        result[lab] = {"낱말": words, "예시": examples}
    return result


def main():
    criteria = json.load(open(os.path.join(ROOT, "criteria.json"), encoding="utf-8"))
    practice = json.load(open(os.path.join(ROOT, "data", "practice.json"), encoding="utf-8"))
    cats = [c["이름"] for c in criteria["칸"]]
    urgs = [u["이름"] for u in criteria["긴급도"]]
    for x in practice:
        VOCAB.update(tokens(x["text"]))
    out = {
        "설명": "규칙 분류가 쓰는 판단 낱말. data/practice.json 에서만 scripts/build_keywords.py 로 뽑았다. 손으로 고치거나 낱말을 더하지 않는다.",
        "메타": {
            "출처": "data/practice.json",
            "연습문장수": len(practice),
            "최소_등장_문장수": MIN_DF,
            "최소_집중도": MIN_PRECISION,
            "낱말_최소_길이": MIN_LEN,
            "낱말_정의": "어절 끝의 흔한 조사·어미를 뗀 것(2자 이상). 한 글자 조사는 뗀 결과가 연습 문장에 어절로 따로 나올 때만 뗌",
        },
        "칸": extract(practice, "칸", cats),
        "긴급도": extract(practice, "긴급도", urgs),
    }
    json.dump(out, open(os.path.join(ROOT, "keywords.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    for part in ("칸", "긴급도"):
        for lab, v in out[part].items():
            print(part, lab, len(v["낱말"]), "개:", ", ".join(w["낱말"] for w in v["낱말"][:10]), "| 예시 %d개" % len(v["예시"]))


if __name__ == "__main__":
    main()
