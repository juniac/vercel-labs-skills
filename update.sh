#!/usr/bin/env bash

set -e  # Exit on error

echo "🔄 Updating skills CLI..."

# Fetch from upstream
echo "📥 Fetching from upstream..."
git fetch upstream

# Checkout main
echo "🔀 Switching to main..."
git checkout main

# Merge upstream/main
echo "🔀 Merging upstream/main..."
git merge upstream/main

# Build the project
echo "🔨 Building project..."
pnpm build

# Link globally
echo "🔗 Linking globally..."
pnpm link --global

echo "✅ Update complete! The 'skills' command is now updated."