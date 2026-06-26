#!/usr/bin/env bash
# objective.sh — create the first live objective and watch the grid run it.
# Pulls the operator key from SSM (your AWS session), so nothing to paste.
set -uo pipefail
REGION=ca-west-1
GRID=https://play.runechaingame.com/grid
say(){ printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

cat > /tmp/molt-obj.json <<'JSON'
{"title":"First live objective","prompt":"Say hello from the production grid in one sentence.","contract":{"objective_type":"inference"}}
JSON

say "Getting your operator key"
KEY="${MOLT_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY=$(aws ssm get-parameter --name /molt/MOLT_BOOTSTRAP_KEY --with-decryption --query Parameter.Value --output text --region "$REGION" 2>/dev/null) \
    || { echo "  No key. Either run where 'aws login' works, or:  MOLT_API_KEY=op1.… bash objective.sh"; exit 1; }
  echo "  from SSM ✓"
else
  echo "  from MOLT_API_KEY ✓"
fi

say "Auth check"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KEY" "$GRID/events?limit=1")
[ "$CODE" = "200" ] && echo "  GET /events -> 200, key is live ✓" \
  || { echo "  GET /events -> $CODE — key not live yet (broker still rolling?). Wait a minute and re-run."; exit 1; }

say "Creating the objective"
RESP=$(curl -s -X POST "$GRID/objectives" -H "authorization: Bearer $KEY" -H "content-type: application/json" -d @/tmp/molt-obj.json)
echo "  $RESP"
OBJ=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("objective_id",""))' 2>/dev/null || true)
[ -n "$OBJ" ] || { echo "  no objective id back — paste this whole output to Claude."; exit 1; }

say "Watching $OBJ flow (up to ~90s)"
for _ in $(seq 1 45); do
  ST=$(curl -s -H "authorization: Bearer $KEY" "$GRID/jobs?objective=$OBJ" | python3 -c 'import sys,json
try: print(",".join(j.get("status","") for j in json.load(sys.stdin)))
except Exception: print("")' 2>/dev/null)
  echo "  jobs: ${ST:-(none yet)}"
  printf '%s' "$ST" | grep -q accepted && { echo "  >>> ACCEPTED — the grid ran it end to end. <<<"; break; }
  sleep 3
done

say "Recent event stream"
curl -s -H "authorization: Bearer $KEY" "$GRID/events?limit=14" | python3 -c 'import sys,json
for e in json.load(sys.stdin): print("  %-18s %s"%(e.get("event_type",""), e.get("entity_id","")))' 2>/dev/null
echo
echo "Dashboard: $GRID/dashboard"
