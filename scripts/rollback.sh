#!/bin/bash

# Rollback Script for French Assessment App
# This script helps you safely rollback changes

set -e  # Exit on error

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════╗"
echo "║  French Assessment - Rollback Utility     ║"
echo "╔════════════════════════════════════════════╗"
echo -e "${NC}"
echo ""

# Function to show current branch and commit
show_current_state() {
    echo -e "${BLUE}Current State:${NC}"
    echo "  Branch: $(git branch --show-current)"
    echo "  Commit: $(git log -1 --oneline)"
    echo ""
}

# Function to list recent commits
show_recent_commits() {
    echo -e "${BLUE}Recent Commits:${NC}"
    git log --oneline --max-count=10 --decorate
    echo ""
}

# Main menu
main_menu() {
    show_current_state
    echo -e "${YELLOW}What would you like to do?${NC}"
    echo ""
    echo "1. 🔄 Disable all feature flags (safe, no code changes)"
    echo "2. ↩️  Revert to last commit (undo most recent changes)"
    echo "3. ⏮️  Revert to specific commit"
    echo "4. 🏷️  View all commits"
    echo "5. 🌿 Switch to main branch"
    echo "6. 💾 Create backup of current state"
    echo "7. 🗑️  Delete feature branch"
    echo "8. 📊 Show git status"
    echo "9. ❌ Exit"
    echo ""
    read -p "Enter your choice (1-9): " choice

    case $choice in
        1) disable_feature_flags ;;
        2) revert_last_commit ;;
        3) revert_to_commit ;;
        4) view_all_commits ;;
        5) switch_to_main ;;
        6) create_backup ;;
        7) delete_feature_branch ;;
        8) show_git_status ;;
        9) exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}"; sleep 1; main_menu ;;
    esac
}

# Function 1: Disable feature flags
disable_feature_flags() {
    echo -e "${YELLOW}Disabling all feature flags...${NC}"

    if [ ! -f .env.local ]; then
        echo -e "${RED}No .env.local file found${NC}"
        echo "Creating .env.local with all flags disabled..."
        cp .env.example .env.local
    fi

    # Update .env.local to disable all flags
    sed -i.bak 's/NEXT_PUBLIC_ENABLE_.*=true/NEXT_PUBLIC_ENABLE_STUDY_CODES=false/' .env.local
    sed -i.bak 's/NEXT_PUBLIC_ENABLE_.*=true/NEXT_PUBLIC_ENABLE_ADMIN_PANEL=false/' .env.local
    sed -i.bak 's/NEXT_PUBLIC_ENABLE_.*=true/NEXT_PUBLIC_ENABLE_DB_SYNC=false/' .env.local
    sed -i.bak 's/NEXT_PUBLIC_ENABLE_.*=true/NEXT_PUBLIC_ENABLE_PROGRESS_TRACKING=false/' .env.local

    echo -e "${GREEN}✅ All feature flags disabled${NC}"
    echo ""
    echo "Restart your dev server for changes to take effect:"
    echo "  npm run dev"
    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 2: Revert last commit
revert_last_commit() {
    show_current_state
    echo -e "${YELLOW}This will undo your last commit.${NC}"
    echo -e "${RED}⚠️  Warning: This cannot be undone easily${NC}"
    echo ""
    read -p "Are you sure? (yes/no): " confirm

    if [ "$confirm" = "yes" ]; then
        git revert HEAD --no-edit
        echo -e "${GREEN}✅ Last commit reverted${NC}"
    else
        echo "Cancelled"
    fi

    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 3: Revert to specific commit
revert_to_commit() {
    show_recent_commits
    echo -e "${YELLOW}Enter the commit hash to revert to:${NC}"
    read -p "Commit hash: " commit_hash

    if [ -z "$commit_hash" ]; then
        echo -e "${RED}No commit hash provided${NC}"
        sleep 1
        main_menu
        return
    fi

    echo ""
    echo -e "${RED}⚠️  This will reset to commit: $commit_hash${NC}"
    echo -e "${RED}⚠️  All changes after this commit will be lost${NC}"
    echo ""
    read -p "Are you SURE? Type 'RESET' to confirm: " confirm

    if [ "$confirm" = "RESET" ]; then
        git reset --hard "$commit_hash"
        echo -e "${GREEN}✅ Reset to commit $commit_hash${NC}"
    else
        echo "Cancelled"
    fi

    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 4: View all commits
view_all_commits() {
    echo -e "${BLUE}Commit History:${NC}"
    git log --oneline --decorate --graph --all
    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 5: Switch to main branch
switch_to_main() {
    current_branch=$(git branch --show-current)

    if [ "$current_branch" = "main" ]; then
        echo -e "${GREEN}Already on main branch${NC}"
    else
        echo -e "${YELLOW}Switching from $current_branch to main...${NC}"

        # Check for uncommitted changes
        if ! git diff-index --quiet HEAD --; then
            echo -e "${RED}You have uncommitted changes${NC}"
            echo ""
            read -p "Stash changes and switch? (yes/no): " stash

            if [ "$stash" = "yes" ]; then
                git stash
                git checkout main
                echo -e "${GREEN}✅ Switched to main (changes stashed)${NC}"
            else
                echo "Cancelled"
            fi
        else
            git checkout main
            echo -e "${GREEN}✅ Switched to main${NC}"
        fi
    fi

    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 6: Create backup
create_backup() {
    timestamp=$(date +%Y%m%d_%H%M%S)
    backup_branch="backup_${timestamp}"

    echo -e "${YELLOW}Creating backup branch: $backup_branch${NC}"
    git branch "$backup_branch"
    echo -e "${GREEN}✅ Backup created${NC}"
    echo ""
    echo "You can restore this backup later with:"
    echo "  git checkout $backup_branch"
    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 7: Delete feature branch
delete_feature_branch() {
    echo -e "${BLUE}Available branches:${NC}"
    git branch
    echo ""

    read -p "Enter branch name to delete: " branch_name

    if [ -z "$branch_name" ]; then
        echo -e "${RED}No branch name provided${NC}"
        sleep 1
        main_menu
        return
    fi

    if [ "$branch_name" = "main" ]; then
        echo -e "${RED}Cannot delete main branch${NC}"
        sleep 2
        main_menu
        return
    fi

    echo -e "${RED}⚠️  This will delete branch: $branch_name${NC}"
    read -p "Are you sure? (yes/no): " confirm

    if [ "$confirm" = "yes" ]; then
        git branch -D "$branch_name"
        echo -e "${GREEN}✅ Branch deleted${NC}"
    else
        echo "Cancelled"
    fi

    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Function 8: Show git status
show_git_status() {
    echo -e "${BLUE}Git Status:${NC}"
    git status
    echo ""
    read -p "Press Enter to continue..."
    main_menu
}

# Start the script
main_menu
