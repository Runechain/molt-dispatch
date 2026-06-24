# Go-live checklist — molt broker on production

Everything below is staged and verified. These are the steps that require a human (deploy
authorization, AWS SSO, a secret, a Google-account claim) — they can't be automated by the agent.

Prod broker: `https://play.runechaingame.com/grid` (ECS Fargate, ca-west-1, acct 901889466248).
Deploy is GitHub Actions on push to `master` of `Runechain/molt-dispatch` (OIDC — no local AWS needed).

## 1. Ship the dashboard fix + durability + streaming log

Merge **[PR #6](https://github.com/Runechain/molt-dispatch/pull/6)** (`feat/molt-go` → `master`).
CI runs `npm test` (green: 115 checks) then builds + deploys the broker.

Verify after it lands (no AWS needed):
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://play.runechaingame.com/grid/dashboard/app.js   # 200
# open https://play.runechaingame.com/grid/dashboard — should render (workers panel populates)
```

## 2. Seed the operator key (unlocks the event feed + objective creation)

```bash
aws sso login                                                  # your SSO; the agent can't do this
KEY="op1.$(openssl rand -hex 24)"; echo "SAVE THIS — operator key: $KEY"
aws ssm put-parameter --name /molt/MOLT_BOOTSTRAP_KEY --type SecureString \
  --value "$KEY" --overwrite --region ca-west-1
```

## 3. Deploy the operator-key wiring

The task-def already references `MOLT_BOOTSTRAP_KEY` (left out of PR #6 on purpose — deploying the
secret-ref before step 2 would crash the broker on boot). After step 2:
```bash
git add .aws/molt-broker-task-definition.json
git commit -m "Wire MOLT_BOOTSTRAP_KEY operator key"
git push origin master     # redeploys; broker seeds the key on boot
```

## 4. Run a worker that stays up + claim it once

```bash
node bin/molt.mjs go        # reuses your claimed key; confirm the /claim link once if prompted
```

## 5. Watch it live

```bash
MOLT_API_KEY="$KEY" node bin/molt.mjs logs                     # live event tail
# create an objective (operator key) and watch decompose → deliberate → dispatch → execute → validate:
curl -s -X POST https://play.runechaingame.com/grid/objectives \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"first live objective","prompt":"...","contract":{"objective_type":"inference"}}'
```

Dashboard (with the operator key, the event + objective panels populate): `…/grid/dashboard`.
