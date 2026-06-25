#!/usr/bin/env bash
# watch.sh — live operator view of the grid in your terminal. Refreshes every 2s.
# Pulls the operator key from SSM (your AWS session); or set MOLT_API_KEY=op1.… to skip AWS.
set -uo pipefail
REGION=ca-west-1
G=https://play.runechaingame.com/grid

KEY="${MOLT_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY=$(aws ssm get-parameter --name /molt/MOLT_BOOTSTRAP_KEY --with-decryption --query Parameter.Value --output text --region "$REGION" 2>/dev/null) \
    || { echo "No key. Run where 'aws login' works, or:  MOLT_API_KEY=op1.… bash watch.sh"; exit 1; }
fi

trap 'echo; echo "(stopped)"; exit 0' INT
while true; do
  SNAP=$(
    printf '\033[H\033[2J'
    printf '\033[1;36mRUNECHAIN molt — live grid\033[0m   %s   (Ctrl-C to stop)\n' "$(date +%H:%M:%S)"
    echo   '──────────────────────────────────────────────────────────'
    echo 'WORKERS'
    curl -s -H "authorization: Bearer $KEY" "$G/workers" | python3 -c 'import sys,json
ws=json.load(sys.stdin); busy=sum(1 for w in ws if (w.get("active_slots") or 0)>0)
print(f"  {len(ws)} online · {busy} busy")
for w in ws: print("   %-26s %-8s %s/%s"%(w.get("id"),w.get("status"),w.get("active_slots"),w.get("max_slots")))' 2>/dev/null
    echo 'OBJECTIVES'
    curl -s -H "authorization: Bearer $KEY" "$G/objectives" | python3 -c 'import sys,json
os=json.load(sys.stdin); print(f"  {len(os)}")
for o in os: print("   %-8s %-20s %s"%(o.get("id"),o.get("status"),(o.get("title") or "")[:34]))' 2>/dev/null
    echo 'RECENT EVENTS'
    curl -s -H "authorization: Bearer $KEY" "$G/events?limit=12" | python3 -c 'import sys,json
ev=json.load(sys.stdin)
if not ev: print("   (none — gated view means the key is wrong, or nothing has happened yet)")
for e in ev[:12]: print("   %-18s %s"%(e.get("event_type",""), e.get("entity_id","")))' 2>/dev/null
  )
  printf '%s\n' "$SNAP"
  sleep 2
done
