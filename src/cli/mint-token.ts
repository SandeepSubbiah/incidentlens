import { mintToken, type AccessRole } from '../access.ts';

// Usage: ACCESS_SECRET=... node src/cli/mint-token.ts --name judge-1 [--days 7] [--runs 20] [--role judge|admin]

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const name = arg('name', '');
if (!name) {
  console.error('usage: node src/cli/mint-token.ts --name <who> [--days 7] [--runs 20] [--role judge|admin]');
  process.exit(1);
}
const role = arg('role', 'judge') as AccessRole;
const days = Number(arg('days', '7'));
const runs = Number(arg('runs', role === 'admin' ? '200' : '20'));
const token = mintToken({ sub: name, role, exp: Math.floor(Date.now() / 1000) + days * 86400, runs });
console.log(`${role} access code for ${name}, valid ${days} days, ${runs} live investigations:\n\n${token}\n`);
