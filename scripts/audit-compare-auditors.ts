/**
 * Cross-model comparison: Sonnet audit vs Mistral audit.
 * Reads JSON result files from both audits and generates a markdown report.
 *
 * Usage:
 *   npx tsx scripts/compare-audits.ts \
 *     --sonnet data/audit-sonnet.json \
 *     --mistral data/audit-mistral.json \
 *     --output docs/cross-validation-report.md
 */

import { readFileSync, writeFileSync } from 'fs';

interface SonnetResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  notes: string;
}

interface MistralResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  natural_french: boolean;
  register_appropriate: boolean;
  difficulty_appropriate: boolean;
  suggested_difficulty: string | null;
  variations_valid: boolean;
  missing_variations: string[];
  invalid_variations: string[];
  notes: string;
  severity: 'critical' | 'minor' | 'suggestion';
}

interface CLIOptions {
  sonnetPath: string;
  mistralPath: string;
  outputPath: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    sonnetPath: 'data/audit-sonnet.json',
    mistralPath: 'data/audit-mistral.json',
    outputPath: 'docs/cross-validation-report.md',
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sonnet': options.sonnetPath = args[++i]; break;
      case '--mistral': options.mistralPath = args[++i]; break;
      case '--output': options.outputPath = args[++i]; break;
    }
  }
  return options;
}

const SHARED_CRITERIA = ['answer_correct', 'grammar_correct', 'no_hallucination', 'question_coherent'] as const;

function main() {
  const options = parseArgs();

  console.log('Loading audit results...');
  const sonnetResults: SonnetResult[] = JSON.parse(readFileSync(options.sonnetPath, 'utf-8'));
  const mistralResults: MistralResult[] = JSON.parse(readFileSync(options.mistralPath, 'utf-8'));

  console.log(`  Sonnet: ${sonnetResults.length} questions`);
  console.log(`  Mistral: ${mistralResults.length} questions`);

  // Build ID maps
  const sonnetMap = new Map(sonnetResults.map(r => [r.id, r]));
  const mistralMap = new Map(mistralResults.map(r => [r.id, r]));

  // Find overlapping IDs
  const sharedIds = sonnetResults
    .map(r => r.id)
    .filter(id => mistralMap.has(id));

  console.log(`  Shared questions: ${sharedIds.length}`);

  const lines: string[] = [];
  const line = (s: string) => lines.push(s);

  line('# Cross-Validation Report: Sonnet vs Mistral');
  line('');
  line(`**Date**: ${new Date().toISOString().split('T')[0]}`);
  line(`**Sonnet audit**: ${sonnetResults.length} questions`);
  line(`**Mistral audit**: ${mistralResults.length} questions`);
  line(`**Shared questions**: ${sharedIds.length}`);
  line('');

  // ── 1. Agreement Matrix ──────────────────────────────────
  line('## 1. Agreement Matrix (Shared Criteria)');
  line('');
  line('How often Sonnet and Mistral agree on each shared criterion:');
  line('');
  line('| Criterion | Both Pass | Both Fail | Sonnet Only Fail | Mistral Only Fail | Agreement |');
  line('|-----------|-----------|-----------|------------------|-------------------|-----------|');

  for (const criterion of SHARED_CRITERIA) {
    let bothPass = 0, bothFail = 0, sonnetOnlyFail = 0, mistralOnlyFail = 0;

    for (const id of sharedIds) {
      const s = sonnetMap.get(id)!;
      const m = mistralMap.get(id)!;
      const sp = s[criterion];
      const mp = m[criterion];

      if (sp && mp) bothPass++;
      else if (!sp && !mp) bothFail++;
      else if (!sp && mp) sonnetOnlyFail++;
      else mistralOnlyFail++;
    }

    const total = sharedIds.length;
    const agreement = ((bothPass + bothFail) / total * 100).toFixed(1);
    line(`| ${criterion} | ${bothPass} | ${bothFail} | ${sonnetOnlyFail} | ${mistralOnlyFail} | ${agreement}% |`);
  }
  line('');

  // ── 2. Mistral-Only Findings ─────────────────────────────
  line('## 2. Mistral-Only Findings (Blind Spots)');
  line('');
  line('Questions flagged by Mistral but passed by Sonnet. These represent potential Anthropic model blind spots.');
  line('');

  const mistralOnlyFlags: { id: string; criteria: string[]; m: MistralResult }[] = [];
  for (const id of sharedIds) {
    const s = sonnetMap.get(id)!;
    const m = mistralMap.get(id)!;

    // Sonnet passes all 4
    const sonnetAllPass = SHARED_CRITERIA.every(c => s[c]);
    if (!sonnetAllPass) continue;

    // Mistral fails at least one (of any 7)
    const failedCriteria: string[] = [];
    if (!m.answer_correct) failedCriteria.push('answer_correct');
    if (!m.grammar_correct) failedCriteria.push('grammar_correct');
    if (!m.no_hallucination) failedCriteria.push('no_hallucination');
    if (!m.question_coherent) failedCriteria.push('question_coherent');
    if (!m.natural_french) failedCriteria.push('natural_french');
    if (!m.register_appropriate) failedCriteria.push('register_appropriate');
    if (!m.difficulty_appropriate) failedCriteria.push('difficulty_appropriate');
    if (!m.variations_valid) failedCriteria.push('variations_valid');

    if (failedCriteria.length > 0) {
      mistralOnlyFlags.push({ id, criteria: failedCriteria, m });
    }
  }

  line(`**Total**: ${mistralOnlyFlags.length} questions`);
  line('');

  if (mistralOnlyFlags.length > 0) {
    // Group by severity
    const bySeverity = {
      critical: mistralOnlyFlags.filter(f => f.m.severity === 'critical'),
      minor: mistralOnlyFlags.filter(f => f.m.severity === 'minor'),
      suggestion: mistralOnlyFlags.filter(f => f.m.severity === 'suggestion'),
    };

    for (const [severity, items] of Object.entries(bySeverity)) {
      if (items.length === 0) continue;
      line(`### ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${items.length})`);
      line('');
      for (const item of items.slice(0, 20)) { // Limit output
        line(`- **${item.id}** [${item.criteria.join(', ')}]`);
        line(`  - Q: ${item.m.question}`);
        line(`  - A: ${item.m.answer}`);
        line(`  - Notes: ${item.m.notes}`);
      }
      if (items.length > 20) {
        line(`- ... and ${items.length - 20} more`);
      }
      line('');
    }
  }

  // ── 3. Sonnet-Only Findings ──────────────────────────────
  line('## 3. Sonnet-Only Findings (Sonnet False Positives?)');
  line('');
  line('Questions flagged by Sonnet but passed by Mistral (all 7 criteria). These may be Sonnet false positives.');
  line('');

  const sonnetOnlyFlags: { id: string; criteria: string[]; s: SonnetResult }[] = [];
  for (const id of sharedIds) {
    const s = sonnetMap.get(id)!;
    const m = mistralMap.get(id)!;

    // Mistral passes all 7
    const mistralAllPass = m.answer_correct && m.grammar_correct && m.no_hallucination &&
      m.question_coherent && m.natural_french && m.register_appropriate && m.difficulty_appropriate && m.variations_valid;
    if (!mistralAllPass) continue;

    // Sonnet fails at least one of 4
    const failedCriteria: string[] = [];
    for (const c of SHARED_CRITERIA) {
      if (!s[c]) failedCriteria.push(c);
    }

    if (failedCriteria.length > 0) {
      sonnetOnlyFlags.push({ id, criteria: failedCriteria, s });
    }
  }

  line(`**Total**: ${sonnetOnlyFlags.length} questions`);
  line('');

  for (const item of sonnetOnlyFlags.slice(0, 20)) {
    line(`- **${item.id}** [${item.criteria.join(', ')}]`);
    line(`  - Q: ${item.s.question}`);
    line(`  - A: ${item.s.answer}`);
    line(`  - Sonnet notes: ${item.s.notes}`);
  }
  if (sonnetOnlyFlags.length > 20) {
    line(`- ... and ${sonnetOnlyFlags.length - 20} more`);
  }
  line('');

  // ── 4. French-Native Criteria (Mistral Only) ─────────────
  line('## 4. French-Native Criteria (Mistral Only)');
  line('');

  const naturalFrenchFail = mistralResults.filter(r => !r.natural_french).length;
  const registerFail = mistralResults.filter(r => !r.register_appropriate).length;
  const difficultyFail = mistralResults.filter(r => !r.difficulty_appropriate).length;
  const variationsFail = mistralResults.filter(r => !r.variations_valid).length;

  line(`| Criterion | Fail Count | Fail Rate |`);
  line(`|-----------|-----------|-----------|`);
  line(`| natural_french | ${naturalFrenchFail} | ${(naturalFrenchFail / mistralResults.length * 100).toFixed(1)}% |`);
  line(`| register_appropriate | ${registerFail} | ${(registerFail / mistralResults.length * 100).toFixed(1)}% |`);
  line(`| difficulty_appropriate | ${difficultyFail} | ${(difficultyFail / mistralResults.length * 100).toFixed(1)}% |`);
  line(`| variations_valid | ${variationsFail} | ${(variationsFail / mistralResults.length * 100).toFixed(1)}% |`);
  line('');

  // ── 5. Difficulty Reclassification ─────────────────────────
  line('## 5. Difficulty Reclassification Analysis');
  line('');

  const diffMismatches = mistralResults.filter(r => !r.difficulty_appropriate);
  line(`**Total mismatches**: ${diffMismatches.length} / ${mistralResults.length} (${(diffMismatches.length / mistralResults.length * 100).toFixed(1)}%)`);
  line('');

  if (diffMismatches.length > 0) {
    // Build reclassification matrix using the question data for current difficulty
    const mistralQuestionMap = new Map(mistralResults.map(r => [r.id, r]));
    const reclass: Record<string, Record<string, number>> = {};
    for (const r of diffMismatches) {
      // We need the original difficulty — it's not on MistralResult directly, check sonnet results or infer
      const sonnetQ = sonnetMap.get(r.id);
      // Fall back to extracting from notes or use 'unknown'
      const currentDifficulty = sonnetQ ? 'from_sonnet' : 'unknown';
      const suggested = r.suggested_difficulty || 'unknown';
      // Actually we can't reliably get current difficulty from either result interface
      // Let's just show the suggested_difficulty distribution
    }

    line('### Suggested Reclassification Distribution');
    line('');
    line('| Suggested Level | Count |');
    line('|----------------|-------|');
    const suggestedCounts: Record<string, number> = {};
    for (const r of diffMismatches) {
      const s = r.suggested_difficulty || 'unspecified';
      suggestedCounts[s] = (suggestedCounts[s] || 0) + 1;
    }
    for (const [level, count] of Object.entries(suggestedCounts).sort()) {
      line(`| ${level} | ${count} |`);
    }
    line('');

    line('### Mismatched Questions (first 20)');
    line('');
    for (const r of diffMismatches.slice(0, 20)) {
      line(`- **${r.id}** [${r.severity}] suggested: ${r.suggested_difficulty || '?'}`);
      line(`  - Q: ${r.question}`);
      line(`  - Notes: ${r.notes}`);
    }
    if (diffMismatches.length > 20) {
      line(`- ... and ${diffMismatches.length - 20} more`);
    }
    line('');
  }

  // ── 6. Variation Quality ─────────────────────────────────
  line('## 6. Variation Quality Analysis');
  line('');

  const totalMissing = mistralResults.reduce((sum, r) => sum + r.missing_variations.length, 0);
  const totalInvalid = mistralResults.reduce((sum, r) => sum + r.invalid_variations.length, 0);
  const qWithMissing = mistralResults.filter(r => r.missing_variations.length > 0).length;
  const qWithInvalid = mistralResults.filter(r => r.invalid_variations.length > 0).length;

  line(`- **Missing variations suggested**: ${totalMissing} across ${qWithMissing} questions`);
  line(`- **Invalid variations flagged**: ${totalInvalid} across ${qWithInvalid} questions`);
  line('');

  if (totalInvalid > 0) {
    line('### Invalid Variations (should be removed)');
    line('');
    for (const r of mistralResults.filter(r => r.invalid_variations.length > 0).slice(0, 15)) {
      line(`- **${r.id}**: ${r.invalid_variations.join(', ')}`);
      line(`  - Q: ${r.question} | A: ${r.answer}`);
    }
    line('');
  }

  if (totalMissing > 0) {
    line('### Missing Variations (should be added)');
    line('');
    for (const r of mistralResults.filter(r => r.missing_variations.length > 0).slice(0, 15)) {
      line(`- **${r.id}**: ${r.missing_variations.join(', ')}`);
      line(`  - Q: ${r.question} | A: ${r.answer}`);
    }
    line('');
  }

  // ── 7. Per-Type Breakdown ────────────────────────────────
  line('## 7. Per-Type Breakdown');
  line('');
  line('| Type | Sonnet Pass | Mistral Pass (Core 4) | Mistral Pass (All 8) |');
  line('|------|-------------|----------------------|---------------------|');

  const types = [...new Set([...sonnetResults.map(r => r.type), ...mistralResults.map(r => r.type)])];
  for (const t of types) {
    const sType = sonnetResults.filter(r => r.type === t);
    const mType = mistralResults.filter(r => r.type === t);
    const sPass = sType.filter(r => SHARED_CRITERIA.every(c => r[c])).length;
    const mCore4Pass = mType.filter(r => SHARED_CRITERIA.every(c => r[c as keyof MistralResult] as boolean)).length;
    const mAllPass = mType.filter(r =>
      r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent &&
      r.natural_french && r.register_appropriate && r.difficulty_appropriate && r.variations_valid
    ).length;

    const sRate = sType.length > 0 ? `${sPass}/${sType.length} (${(sPass / sType.length * 100).toFixed(1)}%)` : 'N/A';
    const mCore4Rate = mType.length > 0 ? `${mCore4Pass}/${mType.length} (${(mCore4Pass / mType.length * 100).toFixed(1)}%)` : 'N/A';
    const mAllRate = mType.length > 0 ? `${mAllPass}/${mType.length} (${(mAllPass / mType.length * 100).toFixed(1)}%)` : 'N/A';

    line(`| ${t} | ${sRate} | ${mCore4Rate} | ${mAllRate} |`);
  }
  line('');

  // ── 8. Per-Topic Breakdown ───────────────────────────────
  line('## 8. Per-Topic Breakdown (Mistral, All 8 Criteria)');
  line('');
  line('| Topic | Total | Pass | Fail | Pass Rate |');
  line('|-------|-------|------|------|-----------|');

  const topics = [...new Set(mistralResults.map(r => r.topic))].sort();
  for (const topic of topics) {
    const tResults = mistralResults.filter(r => r.topic === topic);
    const tPass = tResults.filter(r =>
      r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent &&
      r.natural_french && r.register_appropriate && r.difficulty_appropriate && r.variations_valid
    ).length;
    const rate = (tPass / tResults.length * 100).toFixed(1);
    line(`| ${topic} | ${tResults.length} | ${tPass} | ${tResults.length - tPass} | ${rate}% |`);
  }
  line('');

  // ── 9. Severity Distribution ─────────────────────────────
  line('## 9. Severity Distribution (Mistral)');
  line('');
  const criticalCount = mistralResults.filter(r => r.severity === 'critical').length;
  const minorCount = mistralResults.filter(r => r.severity === 'minor').length;
  const suggestionCount = mistralResults.filter(r => r.severity === 'suggestion').length;
  line(`| Severity | Count | Percentage |`);
  line(`|----------|-------|-----------|`);
  line(`| Critical | ${criticalCount} | ${(criticalCount / mistralResults.length * 100).toFixed(1)}% |`);
  line(`| Minor | ${minorCount} | ${(minorCount / mistralResults.length * 100).toFixed(1)}% |`);
  line(`| Suggestion | ${suggestionCount} | ${(suggestionCount / mistralResults.length * 100).toFixed(1)}% |`);
  line('');

  // ── 10. Actionable Recommendations ───────────────────────
  line('## 10. Actionable Recommendations');
  line('');
  line('Based on cross-validation findings, grouped by pipeline stage:');
  line('');

  // Auto-generate recommendations based on data
  line('### Generation Prompts');
  if (naturalFrenchFail > mistralResults.length * 0.05) {
    line(`- **High unnatural French rate** (${(naturalFrenchFail / mistralResults.length * 100).toFixed(1)}%): Add natural phrasing examples to generation prompts. Consider adding "Write as a native French speaker would" instruction.`);
  }
  if (registerFail > 0) {
    line(`- **Register mismatches** (${registerFail}): Reinforce difficulty-level language constraints in generation prompts.`);
  }
  line('');

  line('### Difficulty Calibration');
  if (difficultyFail > mistralResults.length * 0.1) {
    line(`- **High difficulty mismatch rate** (${(difficultyFail / mistralResults.length * 100).toFixed(1)}%): Strengthen difficulty rubric in generation prompts with concrete cognitive-demand anchors (recognition vs application vs synthesis).`);
  }
  if (difficultyFail > 0) {
    const downgradeCount = diffMismatches.filter(r => {
      const levels = ['beginner', 'intermediate', 'advanced'];
      const suggested = r.suggested_difficulty || '';
      // Can't determine direction without current difficulty on result
      return suggested === 'beginner';
    }).length;
    if (downgradeCount > diffMismatches.length * 0.5) {
      line(`- **Systematic over-labeling**: ${downgradeCount}/${diffMismatches.length} mismatches suggest downgrade to beginner. Generation model may be inflating difficulty labels.`);
    }
  }
  line('');

  line('### Validation Prompts');
  if (totalInvalid > 0) {
    line(`- **${totalInvalid} invalid variations** detected: Tighten variation validation to reject non-equivalent answers.`);
  }
  if (totalMissing > 10) {
    line(`- **${totalMissing} missing variations** suggested: Expand variation generation to cover common alternate phrasings.`);
  }
  line('');

  line('### Evaluation Thresholds');
  if (mistralOnlyFlags.length > sharedIds.length * 0.05) {
    line(`- **${mistralOnlyFlags.length} Anthropic blind spots** found: Review flagged questions and consider adding patterns to the grammar reference in evaluation prompts.`);
  }
  line('');

  line('---');
  line('*Generated by `scripts/compare-audits.ts`*');

  // Write report
  const report = lines.join('\n');
  writeFileSync(options.outputPath, report);
  console.log(`\nReport written to ${options.outputPath}`);
  console.log(`  Shared questions analyzed: ${sharedIds.length}`);
  console.log(`  Mistral-only flags: ${mistralOnlyFlags.length}`);
  console.log(`  Sonnet-only flags: ${sonnetOnlyFlags.length}`);
}

main();
