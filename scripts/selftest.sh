#!/usr/bin/env bash
# meshdirect self-test (run on GETH loopback). Usage: selftest.sh <dev-password> [username]
# Prints secret-clean transcript. Measures TTFT (chat POST -> first SSE delta).
set -u
BASE=http://127.0.0.1:31841
API=$BASE/qwen38/api
ORIGIN="Origin: http://127.0.0.1:31841"
JAR=/opt/meshdirect/sessions/.test-cookies
PASS=${1:?usage: selftest.sh <dev-password>}
USER=${2:-meshdev}
rm -f "$JAR"
j() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const o=JSON.parse(s);console.log(JSON.stringify(eval('o.'+process.argv[1])))}catch(e){console.log('PARSE_ERR:'+s.slice(0,200))}})" "$1"; }

echo "== health =="
curl -s -o /dev/null -w '%{http_code} ' $API/health; curl -s $API/health; echo
echo "== session (unauth) =="
curl -s $API/session; echo
echo "== login: no Origin -> expect 403 =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/login -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}"
echo "== login: wrong password -> expect 401 =="
curl -s -X POST $API/login -H "$ORIGIN" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"nope\"}"; echo
echo "== login: good =="
LOGIN=$(curl -s -c "$JAR" -X POST $API/login -H "$ORIGIN" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}")
echo "$LOGIN" | head -c 400; echo
CSRF=$(echo "$LOGIN" | j csrfToken | tr -d '"')
echo "csrf: ${CSRF:0:6}..."
echo "== session (auth) =="
curl -s -b "$JAR" $API/session | head -c 200; echo
echo "== history preview (imported, limit 3) =="
curl -s -b "$JAR" "$API/history?model=preview&limit=3" | j 'messages.length'
curl -s -b "$JAR" "$API/history?model=bogus"; echo
curl -s -b "$JAR" "$API/history?model=preview&sessionId=other"; echo
echo "== state =="
curl -s -b "$JAR" $API/state | j 'harnessVersion'
curl -s -b "$JAR" $API/state | j 'models.map(m=>({m:m.model,busy:m.busy,msgs:m.messageCount}))'
echo "== chat -> 202 =="
T0=$(date +%s%3N)
TURN1="selftest-$(date +%s%N)-stable"
CHAT=$(curl -s -b "$JAR" -X POST $API/chat -H "$ORIGIN" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"message\":\"Reply with exactly: meshdirect selftest ok\",\"model\":\"stable\",\"sessionId\":\"main\",\"clientTurnId\":\"$TURN1\"}")
echo "$CHAT" | head -c 300; echo
JOB=$(echo "$CHAT" | j jobId | tr -d '"')
echo "jobId: ${JOB:0:8}..."
echo "== SSE stream (curl -N, first 60 lines) =="
FIRST_DELTA_MS=""
curl -s -N -b "$JAR" "$API/chat/$JOB/stream" | while IFS= read -r line; do
  case "$line" in
    "event: delta"*) [ -z "$FIRST_DELTA_MS" ] && { FIRST_DELTA_MS=$(date +%s%3N); echo "TTFT_MS=$((FIRST_DELTA_MS-T0))"; } ;;
  esac
  echo "$line" | head -c 160
done | head -60
echo "== poll job after done =="
curl -s -b "$JAR" "$API/chat/$JOB" | head -c 400; echo
echo "== history stable (new turn present?) =="
curl -s -b "$JAR" "$API/history?model=stable&limit=2" | j 'messages.map(m=>m.role+":"+m.content.slice(0,40))'
echo "== static regression: redirect + favicon =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' $BASE/qwen38/)
echo "GET /qwen38/ -> $CODE (must be 200)"; [ "$CODE" = "200" ] || echo "FAIL: /qwen38/ returned $CODE"
REDIR=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $BASE/qwen38)
echo "GET /qwen38 -> $REDIR (must be single 302/308 to /qwen38/)"
case "$REDIR" in 30[28]*"$BASE/qwen38/") ;; *) echo "FAIL: /qwen38 redirect = $REDIR";; esac
NREDIR=$(curl -s -L --max-redirs 3 -o /dev/null -w '%{num_redirects} final=%{http_code}' $BASE/qwen38)
echo "redirect chain: $NREDIR (must be '1 final=200')"; [ "$NREDIR" = "1 final=200" ] || echo "FAIL: redirect chain $NREDIR"
FAV=$(curl -s -o /dev/null -w '%{http_code}' $BASE/qwen38/favicon.svg)
echo "GET /qwen38/favicon.svg -> $FAV (must be 200)"; [ "$FAV" = "200" ] || echo "FAIL: favicon $FAV"
echo "== abort test =="
TURN2="selftest-$(date +%s%N)-abort"
CHAT2=$(curl -s -b "$JAR" -X POST $API/chat -H "$ORIGIN" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"message\":\"Write a very long essay about the history of computing, at least 2000 words.\",\"model\":\"preview\",\"clientTurnId\":\"$TURN2\"}")
JOB2=$(echo "$CHAT2" | j jobId | tr -d '"')
sleep 2
curl -s -b "$JAR" -X POST "$API/chat/$JOB2/abort" -H "$ORIGIN" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{}'; echo
curl -s -b "$JAR" "$API/chat/$JOB2" | j 'state'
FAILED_MARKED=$(grep -c '"failed":true' /opt/meshdirect/sessions/preview-main.jsonl 2>/dev/null || echo 0)
echo "failed-tagged rows in preview transcript: $FAILED_MARKED (must be >= 1)"
[ "$FAILED_MARKED" -ge 1 ] || echo "FAIL: aborted turn not tagged failed"
echo "== logout =="
curl -s -o /dev/null -w '%{http_code}\n' -b "$JAR" -X POST $API/logout -H "$ORIGIN" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{}'
curl -s -b "$JAR" $API/session; echo
rm -f "$JAR"
echo "DONE"
