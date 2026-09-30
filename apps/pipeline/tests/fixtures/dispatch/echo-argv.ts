/**
 * Fixture command for spawn-command.ts's end-to-end test: prints the argv it received and exits
 * with the code named by --exit-code (default 0). Not discoverable as a real pipeline command —
 * "echo" isn't a recognized area prefix.
 */
console.log(JSON.stringify(process.argv.slice(2)));
const exitCodeIndex = process.argv.indexOf('--exit-code');
process.exit(exitCodeIndex !== -1 ? Number(process.argv[exitCodeIndex + 1]) : 0);
