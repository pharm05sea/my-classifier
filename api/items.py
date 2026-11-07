"""팀 공유 업무 목록 서버 함수 (Vercel).

저장소: Upstash Redis (Vercel Storage → Upstash for Redis 를 프로젝트에 연결하면 환경 변수가 자동으로 생김)
  주소  UPSTASH_REDIS_REST_URL  또는 KV_REST_API_URL
  토큰  UPSTASH_REDIS_REST_TOKEN 또는 KV_REST_API_TOKEN

요청
  GET  /api/items                          → {"items": [...]}
  POST /api/items {"action":"add","item":{...}}            → {"item": {...}}
  POST /api/items {"action":"update","id":"..","patch":{...}} → {"item": {...}}
  POST /api/items {"action":"delete","id":".."}            → {"ok": true}

저장하는 것은 브라우저에서 개인정보(이름·전화번호·사번·이메일)를 가린 문장과 분류 값뿐이다.
요청 내용은 로그에 남기지 않는다. 파이썬 표준 라이브러리만 쓴다.
"""
import json
import os
import time
import uuid
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

KEY = "npd:items"
MAX_ITEMS = 3000
MAX_BODY = 20000
EXTRA_STATUS = "추가확인"


class ApiError(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _load(name):
    here = os.path.dirname(os.path.abspath(__file__))
    for base in (os.path.join(here, ".."), os.getcwd(), "/var/task"):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    raise ApiError(500, name + " 을 찾지 못했습니다")


def names():
    crit = _load("criteria.json")
    stat = _load("status.json")
    return ([c["이름"] for c in crit["칸"]], [u["이름"] for u in crit["긴급도"]],
            [s["이름"] for s in stat["처리상태"]] + [EXTRA_STATUS])


# ---------------------------------------------------------------- Upstash Redis (REST)
def redis_cfg():
    url = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN")
    return (url.rstrip("/"), token) if url and token else (None, None)


def redis(*cmd):
    url, token = redis_cfg()
    if not url:
        raise ApiError(503, "공유 저장소(Upstash Redis)가 연결되지 않았습니다")
    req = urllib.request.Request(url, data=json.dumps(list(cmd)).encode("utf-8"),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ApiError(502, "공유 저장소 오류 (HTTP %d)" % e.code)
    except Exception:
        raise ApiError(502, "공유 저장소에 연결하지 못했습니다")
    if isinstance(payload, dict) and payload.get("error"):
        raise ApiError(502, "공유 저장소 오류")
    return payload.get("result") if isinstance(payload, dict) else None


# ---------------------------------------------------------------- 값 검사
def _s(v, limit):
    return str(v if v is not None else "").strip()[:limit]


def clean_item(raw, cats, urgs, stats):
    if not isinstance(raw, dict):
        raise ApiError(400, "업무 형식이 올바르지 않습니다")
    text = _s(raw.get("text"), 500)
    if not text:
        raise ApiError(400, "문장이 비어 있습니다")
    item = {"text": text}
    for key, allowed in (("cat", cats), ("urg", urgs), ("stat", stats)):
        if raw.get(key) not in allowed:
            raise ApiError(400, "%s 값이 기준에 없습니다" % key)
        item[key] = raw[key]
    item["owner"] = _s(raw.get("owner"), 30)
    item["check"] = bool(raw.get("check"))
    item["edited"] = bool(raw.get("edited"))
    item["reason"] = _s(raw.get("reason"), 300)
    item["why"] = _s(raw.get("why"), 300)
    item["mode"] = "ai" if raw.get("mode") == "ai" else "rule"
    item["src"] = "sample" if raw.get("src") == "sample" else "user"
    ai = raw.get("ai")
    item["ai"] = ({k: _s(ai.get(k), 40) for k in ("cat", "urg", "stat")} if isinstance(ai, dict) else None)
    item["at"] = int(time.time() * 1000)
    return item


def clean_patch(raw, cats, urgs, stats):
    if not isinstance(raw, dict):
        raise ApiError(400, "수정 형식이 올바르지 않습니다")
    out = {}
    for key, allowed in (("cat", cats), ("urg", urgs), ("stat", stats)):
        if key in raw:
            if raw[key] not in allowed:
                raise ApiError(400, "%s 값이 기준에 없습니다" % key)
            out[key] = raw[key]
    if "owner" in raw:
        out["owner"] = _s(raw["owner"], 30)
    for key in ("check", "edited"):
        if key in raw:
            out[key] = bool(raw[key])
    if not out:
        raise ApiError(400, "바꿀 값이 없습니다")
    return out


def _valid_id(i):
    return isinstance(i, str) and 1 <= len(i) <= 40 and all(c.isalnum() or c in "-_" for c in i)


# ---------------------------------------------------------------- 처리
def list_items():
    flat = redis("HGETALL", KEY) or []
    items = []
    for i in range(0, len(flat) - 1, 2):
        try:
            it = json.loads(flat[i + 1])
            it["id"] = flat[i]
            items.append(it)
        except Exception:
            continue
    items.sort(key=lambda x: x.get("at", 0), reverse=True)
    return items


def process(method, body_bytes):
    """(HTTP 코드, 응답 딕셔너리)"""
    try:
        if method == "GET":
            return 200, {"items": list_items()}
        if not body_bytes or len(body_bytes) > MAX_BODY:
            raise ApiError(400, "요청 크기가 올바르지 않습니다")
        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except Exception:
            raise ApiError(400, "요청을 읽지 못했습니다")
        cats, urgs, stats = names()
        action = body.get("action")
        if action == "add":
            if int(redis("HLEN", KEY) or 0) >= MAX_ITEMS:
                raise ApiError(409, "업무가 %d건을 넘어 더 저장할 수 없습니다. 완료된 업무를 지워 주세요" % MAX_ITEMS)
            item = clean_item(body.get("item"), cats, urgs, stats)
            new_id = uuid.uuid4().hex[:12]
            redis("HSET", KEY, new_id, json.dumps(item, ensure_ascii=False))
            item["id"] = new_id
            return 200, {"item": item}
        item_id = body.get("id")
        if not _valid_id(item_id):
            raise ApiError(400, "업무 id 가 올바르지 않습니다")
        if action == "update":
            cur = redis("HGET", KEY, item_id)
            if not cur:
                raise ApiError(404, "업무를 찾지 못했습니다(이미 지워졌을 수 있습니다)")
            item = json.loads(cur)
            item.update(clean_patch(body.get("patch"), cats, urgs, stats))
            redis("HSET", KEY, item_id, json.dumps(item, ensure_ascii=False))
            item["id"] = item_id
            return 200, {"item": item}
        if action == "delete":
            redis("HDEL", KEY, item_id)
            return 200, {"ok": True}
        raise ApiError(400, "알 수 없는 요청입니다")
    except ApiError as e:
        return e.status, {"error": e.reason}
    except Exception:
        return 500, {"error": "서버 내부 오류"}


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(*process("GET", b""))

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if 0 < length <= MAX_BODY else b""
        self._send(*process("POST", body))

    def log_message(self, *args):
        pass  # 문장 내용이 기록되지 않도록 요청 로그를 끈다
