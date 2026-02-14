#!/usr/bin/env bash
# Three-Cohort Pipeline Quality Comparison Experiment
#
# Runs unattended. Monitor with: tail -f /tmp/experiment-run.log
#
# Cohort A: Existing active unit-2 questions (baseline, already in DB)
# Cohort B: Current pipeline + current markdown
# Cohort C: Current pipeline + reconverted markdown (new PDF prompt)

set -euo pipefail

LOG="/tmp/experiment-run.log"
exec > >(tee "$LOG") 2>&1

UNIT="unit-2"
LEARNINGS="learnings/French 1 Unit 2"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "============================================================"
echo "  THREE-COHORT PIPELINE EXPERIMENT"
echo "  Started: $(date)"
echo "  Unit: $UNIT"
echo "  Log: $LOG"
echo "============================================================"
echo ""

# Step 1: Save current markdown as Cohort B source
echo "=== Step 1/7: Save current markdown as Cohort B source ==="
cp "${LEARNINGS}.md" "${LEARNINGS}.cohort-b.md"
echo "  Saved: ${LEARNINGS}.cohort-b.md"
echo ""

# Step 2: Reconvert PDF with updated prompt
echo "=== Step 2/7: Reconvert PDF with updated prompt ==="
npx tsx scripts/regenerate.ts "$UNIT" --force-convert --convert-only
echo ""

# Step 3: Save new markdown as Cohort C source
echo "=== Step 3/7: Save new markdown as Cohort C source ==="
cp "${LEARNINGS}.md" "${LEARNINGS}.cohort-c.md"
echo "  Saved: ${LEARNINGS}.cohort-c.md"
echo ""

# Step 4: Restore original markdown
echo "=== Step 4/7: Restore original markdown ==="
cp "${LEARNINGS}.cohort-b.md" "${LEARNINGS}.md"
echo "  Restored: ${LEARNINGS}.md"
echo ""

# Step 5: Generate + audit Cohort B
echo "=== Step 5/7: Generate + audit Cohort B ==="
echo "  This step takes 60-90 minutes..."
npx tsx scripts/regenerate.ts "$UNIT" \
  --skip-convert --skip-topics --write-db --audit \
  --batch-id "cohort-b-${TIMESTAMP}" \
  --markdown-file "${LEARNINGS}.cohort-b.md"
echo ""

# Step 6: Generate + audit Cohort C
echo "=== Step 6/7: Generate + audit Cohort C ==="
echo "  This step takes 60-90 minutes..."
npx tsx scripts/regenerate.ts "$UNIT" \
  --skip-convert --skip-topics --write-db --audit \
  --batch-id "cohort-c-${TIMESTAMP}" \
  --markdown-file "${LEARNINGS}.cohort-c.md"
echo ""

# Step 7: Compare cohorts
echo "=== Step 7/7: Compare cohorts ==="
npx tsx scripts/compare-cohorts.ts \
  --cohort-a-unit "$UNIT" \
  --cohort-b "cohort-b-${TIMESTAMP}" \
  --cohort-c "cohort-c-${TIMESTAMP}" \
  --export "data/cohort-comparison-${TIMESTAMP}.json" \
  --report "docs/cohort-comparison.md"
echo ""

echo "============================================================"
echo "  EXPERIMENT COMPLETE"
echo "  Finished: $(date)"
echo "  Report: docs/cohort-comparison.md"
echo "  Data: data/cohort-comparison-${TIMESTAMP}.json"
echo "  Log: $LOG"
echo "============================================================"
