import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Fichiers du projet
const CODE = ['index.js', ...fs.readdirSync('lib').map((f) => path.join('lib', f))];
const DOCS = ['README.md', 'AUDIT.md', '.env.example', 'package.json'].filter((f) => fs.existsSync(f));
const read = (f) => fs.readFileSync(f, 'utf8');
const checks = [];
const check = (name, fn) => {
  try {
    const why = fn();
    checks.push([name, why === true || why === undefined ? null : why]);
  } catch (e) {
    checks.push([name, e.message]);
  }
};

check('Syntaxe valide', () => {
  for (const f of CODE) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
});
check('Commentaires de trois mots maximum', () => {
  const bad = [];
  for (const f of CODE) {
    read(f)
      .split('\n')
      .forEach((line, n) => {
        const m = line.match(/^\s*\/\/\s*(.+)$/);
        if (m && m[1].trim().split(/\s+/).length > 3) bad.push(`${f}:${n + 1}`);
      });
  }
  return bad.length ? bad.join(', ') : true;
});
check('Aucune référence à une IA', () => {
  const words = /\b(claude|chatgpt|openai|anthropic|gpt-?\d|intelligence artificielle|copilot)\b/i;
  const hit = [...CODE, ...DOCS].filter((f) => words.test(read(f)));
  return hit.length ? hit.join(', ') : true;
});
check('Aucun secret dans le code', () => {
  const token = /[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/;
  const hit = [...CODE, ...DOCS].filter((f) => token.test(read(f)) || /SECRET=\S{8,}/.test(read(f)));
  return hit.length ? hit.join(', ') : true;
});
check('.env ignoré par git', () => read('.gitignore').split(/\r?\n/).includes('.env') || 'ajoute .env au .gitignore');
check(
  'Secrets lus depuis .env',
  () => /process\.env\.BOT1_TOKEN/.test(read('index.js')) && /process\.env\.BOT2_TOKEN/.test(read('index.js')),
);
check('Aucun nom de rôle en dur', () => {
  const names = /(ND Modérateur|ND Administrateur|Head Staff|AMBASSADRICE|\bVoid\b|\bNova\b|Univers)/;
  const hit = CODE.filter((f) => names.test(read(f)));
  return hit.length ? hit.join(', ') : true;
});
check('Peu de fichiers', () => CODE.length <= 16 || `${CODE.length} fichiers de code`);
check('Un seul processus, deux clients', () => /bots\.main\.login/.test(read('index.js')) && /bots\.guard\.login/.test(read('index.js')));
check('Base persistante', () => /DatabaseSync/.test(read('lib/base.js')) && /CREATE TABLE IF NOT EXISTS/.test(read('lib/base.js')));
check('Lignes lisibles', () => {
  const long = CODE.flatMap((f) =>
    read(f)
      .split('\n')
      .map((l, n) => [f, n + 1, l.length, l])
      .filter(([, , len, text]) => len > 260 && !/^\s*(CREATE|'|return `<)/.test(text)),
  );
  return long.length ? `${long.length} lignes trop longues (ex. ${long[0][0]}:${long[0][1]})` : true;
});

// Résultat
const failed = checks.filter(([, why]) => why);
console.log(`Contrôles : ${checks.length}`);
console.log(`Échecs : ${failed.length}`);
for (const [name, why] of failed) console.log(`- ${name} : ${why}`);
if (failed.length) process.exit(1);
console.log('Tous les contrôles statiques sont bons.');
