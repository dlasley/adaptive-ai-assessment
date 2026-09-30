/**
 * Bespoke fixture command with no defineCli() call — exports `commandMeta` instead, the same way
 * db-check-connection.ts does.
 */
export const commandMeta = {
  name: 'content-fixture-bespoke',
  description: 'Bespoke fixture command with no defineCli call.',
};
