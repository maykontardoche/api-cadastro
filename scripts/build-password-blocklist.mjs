// Usage: node scripts/build-password-blocklist.mjs <source.txt> <output.txt>
// Keeps only entries the policy could accept (15–128 code points after NFKC), lowercased, unique.
import { readFileSync, writeFileSync } from 'node:fs';

const [source, output] = process.argv.slice(2);
const seen = new Set();
for (const raw of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const value = raw.normalize('NFKC').toLowerCase();
  const length = [...value].length;
  // eslint-disable-next-line no-control-regex
  if (length < 15 || length > 128 || /[\u0000-\u001f\u007f]/.test(value)) continue;
  seen.add(value);
}
writeFileSync(output, [...seen].join('\n') + '\n', 'utf8');
console.log(`kept ${seen.size} entries`);
