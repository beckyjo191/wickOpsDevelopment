#!/usr/bin/env bash
set -euo pipefail

# Wipes Cognito users and DynamoDB table items for the current Amplify sandbox.
# Usage:
#   ./scripts/reset-sandbox-data.sh
#   AMPLIFY_OUTPUTS=./amplify_outputs.json REGION=us-east-2 ./scripts/reset-sandbox-data.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AMPLIFY_OUTPUTS="${AMPLIFY_OUTPUTS:-$ROOT_DIR/amplify_outputs.json}"
REGION="${REGION:-}"
KEEP_COGNITO_USERNAME="${KEEP_COGNITO_USERNAME:-}"
INVENTORY_PREFIX="${INVENTORY_PREFIX:-wickops-inventory-}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required."
  exit 1
fi

if [[ ! -f "$AMPLIFY_OUTPUTS" ]]; then
  echo "amplify_outputs.json not found at: $AMPLIFY_OUTPUTS"
  exit 1
fi

if [[ -z "$REGION" ]]; then
  REGION="$(node -e "const f=require(process.argv[1]);process.stdout.write(String(f?.auth?.aws_region||''));" "$AMPLIFY_OUTPUTS")"
fi

USER_POOL_ID="$(node -e "const f=require(process.argv[1]);process.stdout.write(String(f?.auth?.user_pool_id||''));" "$AMPLIFY_OUTPUTS")"

if [[ -z "$REGION" || -z "$USER_POOL_ID" ]]; then
  echo "Could not read region/user pool id from $AMPLIFY_OUTPUTS"
  exit 1
fi

echo "Region: $REGION"
echo "User Pool: $USER_POOL_ID"
echo
echo "This will:"
echo "1) Delete Cognito users in the pool"
echo "2) Delete all items from sandbox DynamoDB tables in this account/region"
echo "3) Delete all items from per-org inventory tables with prefix: $INVENTORY_PREFIX"
echo
read -r -p "Type 'RESET' to continue: " confirm
if [[ "$confirm" != "RESET" ]]; then
  echo "Cancelled."
  exit 0
fi

echo
echo "Deleting Cognito users..."
mapfile -t COGNITO_USERS < <(
  aws cognito-idp list-users \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --query 'Users[].Username' \
    --output text | tr '\t' '\n' | sed '/^$/d'
)

for username in "${COGNITO_USERS[@]:-}"; do
  if [[ -n "$KEEP_COGNITO_USERNAME" && "$username" == "$KEEP_COGNITO_USERNAME" ]]; then
    echo "Keeping Cognito user: $username"
    continue
  fi
  aws cognito-idp admin-delete-user \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" >/dev/null
  echo "Deleted Cognito user: $username"
done

echo
echo "Resolving DynamoDB tables..."
mapfile -t ALL_TABLES < <(
  aws dynamodb list-tables \
    --region "$REGION" \
    --query 'TableNames[]' \
    --output text | tr '\t' '\n' | sed '/^$/d'
)

clear_table_by_id_pk() {
  local table_name="$1"
  local item_count
  item_count="$(aws dynamodb scan \
    --region "$REGION" \
    --table-name "$table_name" \
    --select COUNT \
    --query 'Count' \
    --output text)"
  if [[ "$item_count" == "0" ]]; then
    echo "Table already empty: $table_name"
    return
  fi

  mapfile -t ids < <(
    aws dynamodb scan \
      --region "$REGION" \
      --table-name "$table_name" \
      --projection-expression "id" \
      --query 'Items[].id.S' \
      --output text | tr '\t' '\n' | sed '/^$/d'
  )

  for id in "${ids[@]:-}"; do
    aws dynamodb delete-item \
      --region "$REGION" \
      --table-name "$table_name" \
      --key "{\"id\":{\"S\":\"$id\"}}" >/dev/null
  done
  echo "Cleared $table_name ($item_count items)"
}

for table in "${ALL_TABLES[@]:-}"; do
  if [[ "$table" == *"-organization-"* || "$table" == *"-user-"* || "$table" == *"-invite-"* || "$table" == *"InventoryColumnTable"* || "$table" == *"InventoryItemTable"* || "$table" == "$INVENTORY_PREFIX"* ]]; then
    clear_table_by_id_pk "$table"
  fi
done

echo
echo "Reset complete."
