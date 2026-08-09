#!/bin/bash
# RentingRadar Deploy Script
# Pushes to GitHub and deploys Vercel API routes
# Usage: ./deploy.sh [commit message]

set -e

MSG="${1:-Deploy updates}"

echo "📦 Pushing to GitHub..."
git push

echo ""
echo "🚀 Deploying to Vercel..."
npx vercel --prod

echo ""
echo "✅ Done! GitHub pushed and Vercel deployed."
