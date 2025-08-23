#!/bin/bash

# Script to wrap console.log/error/warn statements with NODE_ENV checks

fix_console_logs() {
  local file=$1
  
  # Fix console.log statements
  sed -i '' 's/^  console\.log(/  if (process.env.NODE_ENV !== '\''production'\'') {\n    console.log(/g' "$file"
  sed -i '' 's/^    console\.log(/    if (process.env.NODE_ENV !== '\''production'\'') {\n      console.log(/g' "$file"
  sed -i '' 's/^      console\.log(/      if (process.env.NODE_ENV !== '\''production'\'') {\n        console.log(/g' "$file"
  
  # Fix console.error statements
  sed -i '' 's/^  console\.error(/  if (process.env.NODE_ENV !== '\''production'\'') {\n    console.error(/g' "$file"
  sed -i '' 's/^    console\.error(/    if (process.env.NODE_ENV !== '\''production'\'') {\n      console.error(/g' "$file"
  sed -i '' 's/^      console\.error(/      if (process.env.NODE_ENV !== '\''production'\'') {\n        console.error(/g' "$file"
  
  # Fix console.warn statements
  sed -i '' 's/^  console\.warn(/  if (process.env.NODE_ENV !== '\''production'\'') {\n    console.warn(/g' "$file"
  sed -i '' 's/^    console\.warn(/    if (process.env.NODE_ENV !== '\''production'\'') {\n      console.warn(/g' "$file"
  sed -i '' 's/^      console\.warn(/      if (process.env.NODE_ENV !== '\''production'\'') {\n        console.warn(/g' "$file"
}

# Process all JWT lambda files
for file in lambda/jwt/*.ts; do
  echo "Processing $file..."
  fix_console_logs "$file"
done

# Process other lambda files that still have console statements
for file in lambda/user/user-batch-service.ts lambda/user/user-stats-service.ts lambda/cognito/*.ts lambda/cedar/entity-management.ts lambda/cedar/policy-initializer.ts lambda/cedar/policy-management.ts; do
  if [ -f "$file" ]; then
    echo "Processing $file..."
    fix_console_logs "$file"
  fi
done

echo "Console log wrapping completed!"