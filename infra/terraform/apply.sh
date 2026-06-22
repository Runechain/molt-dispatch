#!/usr/bin/env bash
# Deploy the molt-dispatch broker infra to AWS.
# Run this after authenticating: aws login
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Verifying AWS access ==="
aws sts get-caller-identity

echo ""
echo "=== terraform init ==="
terraform init

echo ""
echo "=== terraform plan ==="
terraform plan -out=tfplan

echo ""
read -rp "Apply? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "=== terraform apply ==="
terraform apply tfplan

echo ""
BROKER_URL=$(terraform output -raw broker_url)
TASK_ROLE_ARN=$(terraform output -raw broker_task_role_arn)
echo "Broker URL : $BROKER_URL"
echo "Task role  : $TASK_ROLE_ARN"
echo "(EFS IDs are discovered automatically by deploy-grid.yml — no secrets needed for them.)"

echo ""
echo "=== GitHub Actions secret (AWS_ROLE_ARN) ==="
REMOTE=$(git -C "$(dirname "$SCRIPT_DIR")" remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE" ]; then
  echo "No GitHub remote yet — create and push the repo first:"
  echo "  gh repo create molt-dispatch --private --source=\$(dirname \$SCRIPT_DIR) --push"
  echo "Then set the OIDC deploy role (same one used by blockmmo/blockmmo deploy.yml):"
  echo "  gh secret set AWS_ROLE_ARN --repo <your-org>/molt-dispatch"
elif command -v gh &>/dev/null; then
  REPO=$(echo "$REMOTE" | sed 's|.*github\.com[:/]||; s|\.git$||')
  echo "Detected repo: $REPO"
  echo "Setting AWS_ROLE_ARN — enter your OIDC deploy role ARN when prompted:"
  gh secret set AWS_ROLE_ARN --repo "$REPO"
  echo "Secret set. Push to trigger the first deploy."
else
  echo "Install gh (https://cli.github.com) to set secrets from the terminal, or run:"
  echo "  gh secret set AWS_ROLE_ARN --repo <your-org>/molt-dispatch"
fi

echo ""
echo "=== After first deploy: mint the Bedrock worker API key ==="
echo "  node bin/molt.mjs key create --name bedrock-worker"
echo "  # copy the printed key, then:"
echo "  aws ssm put-parameter --name /molt/MOLT_API_KEY --value '<key>' --type SecureString --region us-east-1 --overwrite"
echo ""
echo "Team workers: export MOLT_BROKER_URL=$BROKER_URL"
echo "              export MOLT_API_KEY=<key>"
echo "              molt worker start --adapters bedrock"
