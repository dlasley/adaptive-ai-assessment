#!/bin/bash

# GitHub Setup Script
echo "🚀 GitHub Repository Setup"
echo "=========================="
echo ""

# Step 1: Check git config
echo "Step 1: Checking git configuration..."
if ! git config user.name > /dev/null 2>&1; then
    echo "⚠️  Git user.name not set"
    read -p "Enter your GitHub username: " username
    git config --global user.name "$username"
fi

if ! git config user.email > /dev/null 2>&1; then
    echo "⚠️  Git user.email not set"
    read -p "Enter your GitHub email: " email
    git config --global user.email "$email"
fi

echo "✅ Git config:"
echo "   Name: $(git config user.name)"
echo "   Email: $(git config user.email)"
echo ""

# Step 2: Instructions for creating GitHub repo
echo "Step 2: Create a new GitHub repository"
echo "--------------------------------------"
echo "1. Go to: https://github.com/new"
echo "2. Repository name: french-assessment-app"
echo "3. Description: AI-powered French language assessment tool"
echo "4. Set to: Private (recommended) or Public"
echo "5. Do NOT initialize with README, .gitignore, or license"
echo "6. Click 'Create repository'"
echo ""
read -p "Press Enter after creating the repository..."

# Step 3: Get repo URL
echo ""
read -p "Enter your GitHub repository URL (e.g., https://github.com/username/french-assessment-app.git): " repo_url

# Step 4: Add remote and push
echo ""
echo "Step 3: Connecting to GitHub..."
git remote add origin "$repo_url"
git branch -M main
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed to GitHub!"
    echo "🔗 View your repository: ${repo_url%.git}"
else
    echo ""
    echo "❌ Failed to push. You may need to:"
    echo "   1. Set up GitHub authentication (Personal Access Token or SSH)"
    echo "   2. Visit: https://docs.github.com/en/authentication"
fi
