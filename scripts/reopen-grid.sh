#!/usr/bin/env bash
# Open the RUNECHAIN grid to identity-bound OUTSIDE agents — the two operator-authorized actions
# Claude could not perform alone (an IAM trust grant + opening a live grid), plus verification.
#
# Review, then run as the operator:   bash scripts/reopen-grid.sh
#
# After it succeeds, any outside machine can pull work with:
#   MOLT_BROKER_URL=https://play.runechaingame.com/grid \
#   MOLT_GAME_URL=https://play.runechaingame.com \
#   MOLT_REQUIRE_IDENTITY=1 molt worker start --adapters mock
# (it prints a claim code + /claim URL; confirm once while signed in, then it registers and pulls.)
set -euo pipefail

REPO="Runechain/molt-dispatch"
ROLE="github-action-role"
BROKER="https://play.runechaingame.com/grid"

echo "[1/4] Authorize the org-moved repo on the deploy role's OIDC trust (adds Runechain/molt-dispatch)…"
aws iam update-assume-role-policy --role-name "$ROLE" --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow",
    "Principal":{"Federated":"arn:aws:iam::901889466248:oidc-provider/token.actions.githubusercontent.com"},
    "Action":"sts:AssumeRoleWithWebIdentity",
    "Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
      "StringLike":{"token.actions.githubusercontent.com:sub":[
        "repo:water-bear86/blockmmo:*","repo:water-bear86/molt-dispatch:*",
        "repo:Runechain/blockmmo:*","repo:Runechain/molt-dispatch:*"]}}}]}'
echo "    ✓ trust updated"

echo "[2/4] Merge the open-grid config (PR #2) → triggers the deploy (builds the agent-verify image)…"
gh pr merge chore/open-grid-identity --repo "$REPO" --merge --delete-branch=false 2>/dev/null \
  || gh pr merge 2 --repo "$REPO" --merge
RUN=$(gh run list --repo "$REPO" --branch master --limit 1 --json databaseId --jq '.[0].databaseId')

echo "[3/4] Wait for the deploy ($RUN)…"
gh run watch "$RUN" --repo "$REPO" --exit-status

echo "[4/4] Verify the LIVE broker now opens the ingress but enforces identity…"
sleep 12
echo -n "    unclaimed keyless register -> "
code=$(curl -s -o /tmp/reopen-resp.txt -w '%{http_code}' -X POST "$BROKER/workers/register" \
  -H 'content-type: application/json' -d '{"worker_id":"probe","manifest":{"capabilities":[]}}')
echo "HTTP $code  body: $(head -c 200 /tmp/reopen-resp.txt)"
echo "    EXPECT: 401 with an identity error (agent_credential_missing) — ingress OPEN, identity ENFORCED."
echo "    (Before reopen it was a flat operator-auth 401; now it reaches the agent-claim gate.)"
echo
echo "Done — the grid is open to claimed outside agents. Hand them the 'molt worker start' command above."
