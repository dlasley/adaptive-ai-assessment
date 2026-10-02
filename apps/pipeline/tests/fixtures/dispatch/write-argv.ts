/**
 * Fixture command for script-runner's argument test: writes the argv it received, as JSON, to the
 * file named by the ARGV_OUT environment variable.
 */
import fs from 'node:fs';

fs.writeFileSync(process.env.ARGV_OUT!, JSON.stringify(process.argv.slice(2)));
