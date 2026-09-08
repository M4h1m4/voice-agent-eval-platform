/**
 * CLI runner for Human-to-Automated Evaluator Calibration.
 *
 * Runs the benchmark calibration suite comparing human ground truth against
 * automated evaluator judgments on Fabricated Capability and Silent Request Substitution.
 *
 * Usage:
 *   npx tsx scripts/calibrate.ts
 */
import { runCalibration } from '../lib/eval/judged/calibration.js';

console.log(`\n${'='.repeat(105)}`);
console.log('PART 3: HUMAN-TO-AUTOMATED EVALUATOR CALIBRATION REPORT');
console.log(`${'='.repeat(105)}\n`);

const report = await runCalibration();

console.log(`${'RUN ID'.padEnd(56)} ${'DIFF'.padEnd(14)} ${'HUMAN'.padEnd(10)} ${'JUDGE'.padEnd(10)} MATCH`);
console.log('-'.repeat(105));

for (const item of report.items) {
  const matchStr = item.agreement ? '✅ AGREE' : '❌ DISAGREE';
  console.log(
    `${item.run_id.padEnd(56)} ${item.difficulty.padEnd(14)} ${item.human_verdict.padEnd(10)} ${item.judge_verdict.padEnd(10)} ${matchStr}`,
  );
  if (!item.agreement || item.difficulty === 'boundary_case') {
    console.log(`   Classification: Human=[${item.human_classification}] vs Judge=[${item.judge_classification}]`);
    console.log(`   Rationale: ${item.notes}\n`);
  }
}

console.log('-'.repeat(105));
console.log(`SUMMARY: ${report.agreements}/${report.total} agreements (${(report.agreementRate * 100).toFixed(1)}% agreement rate)`);
console.log(`DISAGREEMENTS: ${report.disagreements}`);
console.log(`\n${report.boundaryAnalysis}\n`);
