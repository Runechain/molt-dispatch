#!/usr/bin/env bash
#
# finish.sh — the last mile: seed the operator key, redeploy the broker, create the first
# objective, and watch your already-live worker pull it. You run this (it mints YOUR key).
#
set -uo pipefail
REGION=ca-west-1
CLUSTER=runechain-cluster
SERVICE=molt-broker-service
GRID=https://play.runechaingame.com/grid
SSM_NAME=/molt/MOLT_BOOTSTRAP_KEY

say(){ printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

say "1/4  AWS check"
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 \
  || die "AWS not authed. Run:  aws login --profile refresh   then re-run this."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
echo "    account $ACCOUNT ✓"

say "2/4  Mint + seed the operator key"
KEY="op1.$(openssl rand -hex 24)"
aws ssm put-parameter --name "$SSM_NAME" --type SecureString --value "$KEY" --overwrite --region "$REGION" >/dev/null \
  || die "ssm put-parameter failed"
printf '    \033[1;33m>>> SAVE THIS OPERATOR KEY <<<\033[0m  %s\n' "$KEY"

say "3/4  Wire it into the broker + redeploy (your live worker self-heals across the reboot)"
SSM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${SSM_NAME}"
CUR=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
        --query 'services[0].taskDefinition' --output text) || die "no service"
aws ecs describe-task-definition --task-definition "$CUR" --region "$REGION" \
  --query 'taskDefinition' > /tmp/molt-td.json || die "describe-task-definition failed"
python3 - "$SSM_ARN" <<'PY' || die "task-def transform failed"
import json, sys
arn = sys.argv[1]; td = json.load(open('/tmp/molt-td.json'))
keep = ['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions',
        'volumes','placementConstraints','requiresCompatibilities','cpu','memory','runtimePlatform']
out = {k: td[k] for k in keep if k in td}; c = out['containerDefinitions'][0]
s = [x for x in c.get('secrets', []) if x['name'] != 'MOLT_BOOTSTRAP_KEY']
s.append({'name': 'MOLT_BOOTSTRAP_KEY', 'valueFrom': arn}); c['secrets'] = s
json.dump(out, open('/tmp/molt-td-new.json', 'w'))
PY
NEWTD=$(aws ecs register-task-definition --cli-input-json file:///tmp/molt-td-new.json --region "$REGION" \
          --query 'taskDefinition.taskDefinitionArn' --output text) || die "register-task-definition failed"
echo "    registered $(basename "$NEWTD")"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEWTD" --region "$REGION" >/dev/null \
  || die "update-service failed"
echo "    redeploying — waiting for the broker to seed the key (a few minutes)…"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  || echo "    (stability wait timed out — testing the key directly below)"
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KEY" "$GRID/events?limit=1")
if [ "$CODE" = "200" ]; then echo "    operator key authenticates ✓"
else
  echo "    key not active yet (HTTP $CODE). If it stays non-200, the execution role may not read $SSM_NAME."
  echo "    Roll back with: aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition $CUR --region $REGION"
fi

say "4/4  Create the first objective → your worker pulls it"
RESP=$(curl -s -X POST "$GRID/objectives" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"First live objective","prompt":"Greet the production grid in one sentence.","contract":{"objective_type":"inference"}}')
echo "    $RESP"
OBJ=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("objective_id",""))' 2>/dev/null || true)
if [ -n "$OBJ" ]; then
  echo "    watching $OBJ…"
  for _ in $(seq 1 45); do
    curl -s -H "authorization: Bearer $KEY" "$GRID/jobs?objective=$OBJ" 2>/dev/null | grep -q '"status":"accepted"' \
      && { echo "    job ACCEPTED ✓ — the grid ran it end-to-end."; break; }
    sleep 2
  done
fi

echo
echo "================= LIVE PRODUCTION GRID ================="
curl -s -H "authorization: Bearer $KEY" "$GRID/events?limit=12" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  ev=json.load(sys.stdin)
  print("  (no events yet — key not active)" if not ev else "")
  for e in ev: print("  %-18s %s"%(e.get("event_type",""), e.get("entity_id","")))
except Exception: print("  (could not read events)")'
echo "======================================================="
printf 'Operator key : \033[1;33m%s\033[0m\n' "$KEY"
echo "Dashboard    : $GRID/dashboard"
echo "Make more    : MOLT_API_KEY=$KEY MOLT_BROKER_URL=$GRID node ~/molt-dispatch/bin/molt.mjs objective create \"Build X\" --prompt \"...\""
