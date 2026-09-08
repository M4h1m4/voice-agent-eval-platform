/**
 * Human review & verdict override persistence (Part 4).
 *
 * Allows clinicians, QA engineers, and researchers to:
 *   1. Annotate traces with review notes
 *   2. Flag false positives / false negatives
 *   3. Explicitly override automated evaluation verdicts
 *   4. Persist review metadata to disk (reviews/<run_id>.json)
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const REVIEWS_DIR = 'reviews';

export interface HumanReview {
  run_id: string;
  reviewer: string;
  verdict_override?: 'pass' | 'fail' | null;
  notes: string;
  tags: string[];
  reviewed_at: number;
}

const fileFor = (dir: string, run_id: string) => join(dir, `${run_id}.json`);

export function saveReview(review: HumanReview, dir = REVIEWS_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = fileFor(dir, review.run_id);
  writeFileSync(path, JSON.stringify(review, null, 2) + '\n', 'utf8');
}

export function loadReview(run_id: string, dir = REVIEWS_DIR): HumanReview | null {
  const path = fileFor(dir, run_id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as HumanReview;
  } catch {
    return null;
  }
}

export function deleteReview(run_id: string, dir = REVIEWS_DIR): void {
  const path = fileFor(dir, run_id);
  if (existsSync(path)) unlinkSync(path);
}

export function listReviews(dir = REVIEWS_DIR): Map<string, HumanReview> {
  const map = new Map<string, HumanReview>();
  if (!existsSync(dir)) return map;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const run_id = f.slice(0, -'.json'.length);
    const rev = loadReview(run_id, dir);
    if (rev) map.set(run_id, rev);
  }
  return map;
}
