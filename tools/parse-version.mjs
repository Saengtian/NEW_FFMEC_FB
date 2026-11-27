/** Extracts the version number from `clasp version` output, cross-platform. */
let output = "";
for await (const chunk of process.stdin) output += chunk;
const match = output.match(/version\s+(\d+)/i);
if (!match) {
  console.error(`Could not parse a version number from: ${output}`);
  process.exit(1);
}
process.stdout.write(match[1]);
