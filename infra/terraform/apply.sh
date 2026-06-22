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
echo "=== Outputs (add these as GitHub secrets) ==="
terraform output -json | jq '{
  MOLT_EFS_ID:      .efs_file_system_id.value,
  MOLT_EFS_AP_ID:   .efs_access_point_id.value,
  BROKER_URL:       .broker_url.value,
  TASK_ROLE_ARN:    .broker_task_role_arn.value
}'

echo ""
echo "Next steps:"
echo "  1. Add MOLT_EFS_ID and MOLT_EFS_AP_ID as GitHub secrets in the molt-dispatch repo"
echo "  2. Push master to GitHub -> deploy-grid.yml builds + deploys the broker"
echo "  3. Once deployed: molt key create --name <team-member>"
echo "     aws ssm put-parameter --name /molt/MOLT_API_KEY --value <key> --type SecureString --region us-east-1"
echo "  4. Team workers: export MOLT_BROKER_URL=\$(terraform output -raw broker_url)"
echo "                    export MOLT_API_KEY=<key>"
echo "                    molt worker start --adapters bedrock"
