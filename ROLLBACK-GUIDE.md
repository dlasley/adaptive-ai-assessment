# Rollback Guide

This guide explains how to safely rollback changes and manage feature flags in the French Assessment app.

## Quick Rollback Options

### Option 1: Disable Features (Fastest & Safest)
```bash
# Just disable the feature flags in .env.local
npm run rollback     # Interactive menu
# OR manually edit .env.local and set all flags to 'false'
```

### Option 2: Use Rollback Script
```bash
./scripts/rollback.sh
# Interactive menu with 9 options
```

### Option 3: Git Commands
```bash
# Undo last commit (safe, keeps history)
git revert HEAD

# Go back to specific commit (destructive)
git reset --hard <commit-hash>

# Switch to safe baseline
git checkout 6bc84e9  # Initial commit before study codes
```

---

## Feature Flags

All new features are controlled by environment variables in `.env.local`:

```bash
# Anonymous Study Code System
NEXT_PUBLIC_ENABLE_STUDY_CODES=false

# Admin Dashboard
NEXT_PUBLIC_ENABLE_ADMIN_PANEL=false

# Database Sync (Supabase)
NEXT_PUBLIC_ENABLE_DB_SYNC=false

# Progress Tracking
NEXT_PUBLIC_ENABLE_PROGRESS_TRACKING=false
```

### How to Use Feature Flags

1. **Enable a feature**: Change `false` to `true` in `.env.local`
2. **Restart server**: `npm run dev`
3. **Test thoroughly**
4. **Disable if issues**: Change back to `false`

---

## Rollback Script Features

Run `./scripts/rollback.sh` for an interactive menu:

```
1. 🔄 Disable all feature flags
   - Safe, no code changes
   - Just updates .env.local
   - Reversible instantly

2. ↩️  Revert to last commit
   - Uses 'git revert' (safe)
   - Keeps commit history
   - Can be undone

3. ⏮️  Revert to specific commit
   - Choose any previous commit
   - WARNING: Destructive
   - Confirm with 'RESET'

4. 🏷️  View all commits
   - See full git history
   - Find commit hashes

5. 🌿 Switch to main branch
   - Go back to main branch
   - Stashes uncommitted changes

6. 💾 Create backup
   - Creates backup branch
   - Preserves current state

7. 🗑️  Delete feature branch
   - Clean up old branches
   - Cannot delete 'main'

8. 📊 Show git status
   - Check current state

9. ❌ Exit
```

---

## Git Commit History

Key commits for rollback:

```bash
# Initial baseline (no study codes)
6bc84e9 - Initial commit - French assessment app baseline

# Feature flags added
8a212af - Add feature flag system and rollback utilities

# To see all commits
git log --oneline
```

---

## Emergency Rollback Procedure

If everything breaks:

```bash
# 1. Stop the dev server
# Press Ctrl+C or kill the process

# 2. Disable all features
./scripts/rollback.sh
# Select option 1: Disable all feature flags

# 3. Restart
npm run dev

# If that doesn't work:
# 4. Reset to baseline
git reset --hard 6bc84e9
npm install
npm run dev
```

---

## Safe Development Workflow

1. **Always work in a branch**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Commit frequently**
   ```bash
   git add .
   git commit -m "Clear description"
   ```

3. **Test before merging**
   ```bash
   # Test with features enabled
   NEXT_PUBLIC_ENABLE_STUDY_CODES=true npm run dev
   ```

4. **Merge when ready**
   ```bash
   git checkout main
   git merge feature/my-feature
   ```

5. **Keep feature flags until stable**
   - Don't remove flags for 1-2 weeks
   - Easy to disable if issues arise

---

## Backup Strategy

### Automatic Backups
- Git history (all commits)
- Existing data in `data/backup/`

### Manual Backups
```bash
# Create backup branch
./scripts/rollback.sh
# Select option 6: Create backup

# Export data
cp data/questions.json data/backup/questions-$(date +%Y%m%d).json

# Backup entire project
tar -czf ~/french-app-backup-$(date +%Y%m%d).tar.gz .
```

---

## Troubleshooting

### "Feature flag not working"
- Check `.env.local` exists and has correct value
- Restart dev server: `npm run dev`
- Check console for feature flag log

### "Git errors"
- Set git config:
  ```bash
  git config --global user.name "Your Name"
  git config --global user.email "your@email.com"
  ```

### "Can't rollback"
- Use rollback script: `./scripts/rollback.sh`
- Check git status: `git status`
- View commits: `git log --oneline`

### "Lost changes"
- Check git stash: `git stash list`
- Restore stash: `git stash pop`
- Check backup branches: `git branch`

---

## Getting Help

1. Check this guide first
2. Run rollback script: `./scripts/rollback.sh`
3. View git status: `git status`
4. Check commit history: `git log`
5. Reset to baseline: `git reset --hard 6bc84e9`

---

## Best Practices

✅ **DO:**
- Use feature flags for new features
- Commit frequently with clear messages
- Test in development before production
- Create backup branches before risky changes
- Keep baseline commit available

❌ **DON'T:**
- Remove feature flags too quickly
- Force push to main branch
- Delete commits without backup
- Skip testing with flags enabled
- Ignore git warnings

---

## Quick Reference

```bash
# Enable study codes
echo "NEXT_PUBLIC_ENABLE_STUDY_CODES=true" >> .env.local

# Disable study codes
sed -i '' 's/NEXT_PUBLIC_ENABLE_STUDY_CODES=true/NEXT_PUBLIC_ENABLE_STUDY_CODES=false/' .env.local

# View current state
git log -1 --oneline
git status

# Rollback last commit
git revert HEAD

# Reset to baseline
git reset --hard 6bc84e9

# Interactive rollback
./scripts/rollback.sh
```
