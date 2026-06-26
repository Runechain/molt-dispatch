#!/usr/bin/env bash
#
# go-live.sh — bring the molt grid fully live on PRODUCTION and watch it run.
#
# You run this. It uses YOUR aws creds and mints YOUR operator key locally — nothing
# sensitive is shared with Claude. Read it before running; it's all plain steps.
#
# It will:
#   1. make sure you're logged into AWS
#   2. mint a random operator key + store it in SSM (prints it ONCE — save it)
#   3. wire that key into the live broker task-def + redeploy (broker seeds it on boot)
#   4. start a worker on this machine (reuses your already-claimed key — no re-claim)
#   5. create an objective through the broker with your key
#   6. print the live workers / jobs / event stream so you SEE the whole thing running
#
# Safe to re-run. If anything fails it tells you how to roll back.

set -uo pipefail

REGION=ca-west-1
CLUSTER=runechain-cluster
SERVICE=molt-broker-service
GRID=https://play.runechaingame.com/grid
SSM_NAME=/molt/MOLT_BOOTSTRAP_KEY
REPO="$HOME/molt-dispatch"

say(){ printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. AWS auth ------------------------------------------------------------
# This box uses a custom credential_process (~/.aws/login-creds.sh) refreshed by `aws login`.
# `aws login` is likely a shell function, so it can't run reliably from inside this script —
# run it yourself in your terminal first if the session has lapsed.
say "1/6  Checking AWS login"
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  die "AWS session expired. In your terminal run:  aws login   — then re-run this script."
fi
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION") || die "no AWS identity"
echo "    account $ACCOUNT ✓"

# ---- 2. mint + store the operator key ---------------------------------------
say "2/6  Minting the operator key"
KEY="op1.$(openssl rand -hex 24)"
aws ssm put-parameter --name "$SSM_NAME" --type SecureString --value "$KEY" --overwrite --region "$REGION" >/dev/null \
  || die "could not write $SSM_NAME (need ssm:PutParameter)"
echo "    stored at $SSM_NAME"
printf '    \033[1;33m>>> SAVE THIS OPERATOR KEY <<<\033[0m  %s\n' "$KEY"

# ---- 3. wire it into the broker + redeploy ----------------------------------
say "3/6  Wiring the key into the live broker + redeploying"
SSM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${SSM_NAME}"
CUR=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
        --query 'services[0].taskDefinition' --output text) || die "no service $SERVICE in $CLUSTER"
[ "$CUR" != "None" ] || die "service $SERVICE not found"
echo "    current task-def: $(basename "$CUR")"
aws ecs describe-task-definition --task-definition "$CUR" --region "$REGION" \
  --query 'taskDefinition' > /tmp/molt-td.json || die "describe-task-definition failed"

# Take the LIVE task-def (keeps the real image, EFS volume, roles, env) and just add the secret.
python3 - "$SSM_ARN" <<'PY' || die "task-def transform failed"
import json, sys
arn = sys.argv[1]
td = json.load(open('/tmp/molt-td.json'))
keep = ['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions',
        'volumes','placementConstraints','requiresCompatibilities','cpu','memory','runtimePlatform']
out = {k: td[k] for k in keep if k in td}
c = out['containerDefinitions'][0]
secs = [s for s in c.get('secrets', []) if s['name'] != 'MOLT_BOOTSTRAP_KEY']
secs.append({'name': 'MOLT_BOOTSTRAP_KEY', 'valueFrom': arn})
c['secrets'] = secs
json.dump(out, open('/tmp/molt-td-new.json', 'w'))
print('    secrets now: ' + ', '.join(s['name'] for s in secs))
PY

NEWTD=$(aws ecs register-task-definition --cli-input-json file:///tmp/molt-td-new.json --region "$REGION" \
          --query 'taskDefinition.taskDefinitionArn' --output text) || die "register-task-definition failed"
echo "    registered $(basename "$NEWTD")"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEWTD" --region "$REGION" >/dev/null \
  || die "update-service failed"
echo "    redeploying — waiting for the broker to reboot + seed the key (can take a few minutes)…"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  || echo "    (stability wait timed out — continuing; the health check below is the real test)"

# Real test: does the new key authenticate against the live broker?
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KEY" "$GRID/events?limit=1")
if [ "$CODE" = "200" ]; then
  echo "    operator key authenticates against prod ✓"
else
  echo "    operator key not active yet (HTTP $CODE). The broker may still be rolling, OR the"
  echo "    execution role can't read $SSM_NAME (it can read /molt/DEEPSEEK_API_KEY, so a /molt/* "
  echo "    policy covers this; an exact-ARN policy would need this param added)."
  echo "    Roll back anytime with:"
  echo "      aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition $CUR --region $REGION"
fi

# ---- 4. start a worker ------------------------------------------------------
say "4/6  Starting a worker (reuses your claimed key — no re-claim if already bound)"
cd "$REPO" || die "no $REPO"
node bin/molt.mjs stop >/dev/null 2>&1 || true
rm -f .molt-worker.pid
: > /tmp/molt-worker.log
nohup node bin/molt.mjs go >/tmp/molt-worker.log 2>&1 &
disown 2>/dev/null || true
ONLINE=""
for _ in $(seq 1 30); do
  grep -q 'online —' /tmp/molt-worker.log 2>/dev/null && { ONLINE=1; break; }
  grep -q 'Claim this agent' /tmp/molt-worker.log 2>/dev/null && break
  sleep 1
done
if [ -n "$ONLINE" ]; then
  echo "    worker online ✓"
elif grep -q 'Claim this agent' /tmp/molt-worker.log 2>/dev/null; then
  echo "    this agent isn't claimed yet — confirm it ONCE (then it stays claimed forever):"
  grep -E 'Open:|confirm code:' /tmp/molt-worker.log | sed 's/^/      /'
  echo "    (the objective below still gets created + decomposed; it executes once you confirm)"
else
  echo "    worker status unclear — tail /tmp/molt-worker.log"
fi

# ---- 5. create an objective -------------------------------------------------
say "5/6  Creating a live objective through the broker"
RESP=$(curl -s -X POST "$GRID/objectives" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"Live grid smoke test","prompt":"Greet the production grid in one sentence.","contract":{"objective_type":"inference"}}')
echo "    $RESP"
OBJ=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("objective_id",""))' 2>/dev/null || true)
[ -n "$OBJ" ] || echo "    (no objective id — if that was a 401, the key isn't active yet; wait a minute and re-run)"

# ---- 6. watch it flow -------------------------------------------------------
say "6/6  Watching it flow (up to ~80s)"
if [ -n "$OBJ" ]; then
  for _ in $(seq 1 40); do
    curl -s -H "authorization: Bearer $KEY" "$GRID/jobs?objective=$OBJ" 2>/dev/null | grep -q '"status":"accepted"' \
      && { echo "    job ACCEPTED ✓"; break; }
    sleep 2
  done
fi

echo
echo "================= LIVE PRODUCTION GRID ================="
echo "WORKERS:"
curl -s -H "authorization: Bearer $KEY" "$GRID/workers" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  for w in json.load(sys.stdin): print("  %-26s %s"%(w.get("id",""), w.get("status","")))
except Exception: print("  (could not read workers)")'
echo "EVENT STREAM (newest first):"
curl -s -H "authorization: Bearer $KEY" "$GRID/events?limit=12" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  ev=json.load(sys.stdin)
  if not ev: print("  (empty — key not active yet)")
  for e in ev: print("  %-18s %s"%(e.get("event_type",""), e.get("entity_id","")))
except Exception: print("  (could not read events)")'
echo "======================================================="
echo
printf 'Operator key : \033[1;33m%s\033[0m\n' "$KEY"
echo "Dashboard    : $GRID/dashboard"
echo "Watch events : curl -H 'authorization: Bearer $KEY' $GRID/events"
echo "Make another : MOLT_API_KEY=$KEY MOLT_BROKER_URL=$GRID node bin/molt.mjs objective create \"Build X\" --prompt \"...\""
echo "Stop worker  : node bin/molt.mjs stop"
