#!/usr/bin/env bash
# Pipeline Quality Experiment Runner
#
# Uses the experiment framework to segregate experiment data from production.
# Questions are written directly to experiment_questions, never to the production table.
#
# Usage:
#   ./scripts/run-experiment.sh <unit-id>
#   ./scripts/run-experiment.sh unit-2
#
# Monitor with: tail -f /tmp/experiment-run.log

set -euo pipefail

LOG="/tmp/experiment-run.log"
exec > >(tee "$LOG") 2>&1

UNIT="${1:?Usage: run-experiment.sh <unit-id>}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LEARNINGS="learnings/French 1 ${UNIT/unit-/Unit }.md"

echo "============================================================"
echo "  PIPELINE QUALITY EXPERIMENT"
echo "  Started: $(date)"
echo "  Unit: $UNIT"
echo "  Log: $LOG"
echo "============================================================"
echo ""

# Step 1: Save current markdown as Cohort B source
echo "=== Step 1/8: Save current markdown as Cohort B source ==="
cp "$LEARNINGS" "${LEARNINGS%.md}.cohort-b.md"
echo "  Saved: ${LEARNINGS%.md}.cohort-b.md"
echo ""

# Step 2: Reconvert PDF with updated prompt
echo "=== Step 2/8: Reconvert PDF with updated prompt ==="
npx tsx scripts/regenerate.ts "$UNIT" --force-convert --convert-only --allow-dirty
echo ""

# Step 3: Save new markdown as Cohort C source
echo "=== Step 3/8: Save new markdown as Cohort C source ==="
cp "$LEARNINGS" "${LEARNINGS%.md}.cohort-c.md"
echo "  Saved: ${LEARNINGS%.md}.cohort-c.md"
echo ""

# Step 4: Restore original markdown
echo "=== Step 4/8: Restore original markdown ==="
cp "${LEARNINGS%.md}.cohort-b.md" "$LEARNINGS"
echo "  Restored: $LEARNINGS"
echo ""

# Step 5: Create experiment + snapshot control (non-interactive mode)
echo "=== Step 5/8: Create experiment + snapshot control ==="
EXPERIMENT_ID=$(npx tsx scripts/create-experiment.ts \
  --unit "$UNIT" \
  --name "Pipeline quality experiment ${TIMESTAMP}" \
  --research-question "Does reconverted markdown improve question quality?" \
  --hypothesis "Reconverted markdown will improve gate pass rate by 5+pp" \
  --variable source_material \
  --metric gate_pass_rate \
  --allow-dirty \
  --output-id)
echo "  Experiment ID: $EXPERIMENT_ID"
echo ""

# Step 6: Generate + audit Cohort B -> experiment_questions directly
echo "=== Step 6/8: Generate + audit Cohort B ==="
echo "  Writing directly to experiment_questions..."
npx tsx scripts/regenerate.ts "$UNIT" \
  --skip-convert --skip-topics --write-db --audit \
  --batch-id "cohort-b-${TIMESTAMP}" \
  --markdown-file "${LEARNINGS%.md}.cohort-b.md" \
  --experiment-id "$EXPERIMENT_ID" --cohort B \
  --allow-dirty
echo ""

# Step 7: Generate + audit Cohort C -> experiment_questions directly
echo "=== Step 7/8: Generate + audit Cohort C ==="
echo "  Writing directly to experiment_questions..."
npx tsx scripts/regenerate.ts "$UNIT" \
  --skip-convert --skip-topics --write-db --audit \
  --batch-id "cohort-c-${TIMESTAMP}" \
  --markdown-file "${LEARNINGS%.md}.cohort-c.md" \
  --experiment-id "$EXPERIMENT_ID" --cohort C \
  --allow-dirty
echo ""

# Step 8: Compare from experiment_questions
echo "=== Step 8/8: Compare experiment cohorts ==="
npx tsx scripts/compare-experiments.ts \
  --experiment "$EXPERIMENT_ID" \
  --export "data/experiment-${TIMESTAMP}.json" \
  --report "docs/experiment-report-${TIMESTAMP}.md"
echo ""

echo "============================================================"
echo "  EXPERIMENT COMPLETE"
echo "  Finished: $(date)"
echo "  Experiment ID: $EXPERIMENT_ID"
echo "  Report: docs/experiment-report-${TIMESTAMP}.md"
echo "  Data: data/experiment-${TIMESTAMP}.json"
echo "  Log: $LOG"
echo "============================================================"
